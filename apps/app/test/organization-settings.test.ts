import { describe, expect, it, vi } from 'vitest'
import { createDb, findOrganizationBySlug, type Db } from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { startCheckout } from '../src/modules/billing/service'
import { isPendingCheckout } from '../src/modules/billing/providers/polar'
import type { BillingProvider } from '../src/modules/billing/provider'
import {
  deleteOrganization,
  getTenant,
  getViewer,
  leaveOrganization,
  renameOrganization,
  transferOwnership,
} from '../src/modules/organizations/service'
import { beginOrganizationDeletion } from '../src/server/auth'
import { withDb } from '../src/server/db'
import {
  authPost,
  createOrg,
  expectStatus,
  joinAs,
  onPaidPlan,
  randomIp,
  signUp,
  type TestUser,
} from './helpers'

// Organization settings (owner decisions 2026-10-31) and ADR-0043's two safeguards: an owner's row
// can't be changed so that an organization has no owner, and a deletion can't race a subscription.

const OWNER_URL = 'postgres://app:app@localhost:5432/app_test'
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
const clientOf = (db: Db) => (rawDb(db) as unknown as { $client: { query: Query } }).$client
const sql = (text: string, params: unknown[] = []) =>
  withDb((db) => clientOf(db).query(text, params))

const orgIdOf = async (slug: string) => (await withDb((db) => findOrganizationBySlug(db, slug)))!.id
const memberIdOf = async (orgId: string, user: TestUser) =>
  (
    await sql('SELECT id FROM member WHERE organization_id = $1 AND user_id = $2', [
      orgId,
      user.userId,
    ])
  ).rows[0]!.id as string
const roleOf = async (orgId: string, user: TestUser) =>
  (
    await sql('SELECT role FROM member WHERE organization_id = $1 AND user_id = $2', [
      orgId,
      user.userId,
    ])
  ).rows[0]?.role as string | undefined
const ownerCount = async (orgId: string) =>
  (
    await sql(
      `SELECT count(*)::int AS n FROM member WHERE organization_id = $1
        AND 'owner' = ANY (string_to_array(replace(role, ' ', ''), ','))`,
      [orgId],
    )
  ).rows[0]!.n as number

/** An organization with an owner, an admin, a member and an outsider with their own organization. */
async function team() {
  const owner = await signUp()
  const slug = await createOrg(owner, 'set')
  const admin = await joinAs(owner, slug, 'admin')
  const member = await joinAs(owner, slug, 'member')
  const outsider = await signUp()
  const otherSlug = await createOrg(outsider, 'oth')
  return { owner, slug, admin, member, outsider, otherSlug, orgId: await orgIdOf(slug) }
}

async function twoOwners() {
  const t = await team()
  await transferToSecondOwner(t.owner, t.orgId, t.admin)
  return {
    a: t.owner,
    b: t.admin,
    orgId: t.orgId,
    slug: t.slug,
    memberA: await memberIdOf(t.orgId, t.owner),
    memberB: await memberIdOf(t.orgId, t.admin),
  }
}

const transferToSecondOwner = async (owner: TestUser, orgId: string, user: TestUser) => {
  const res = await authPost(
    '/organization/update-member-role',
    { memberId: await memberIdOf(orgId, user), role: 'owner', organizationId: orgId },
    randomIp(),
    owner,
  )
  expect(res.ok).toBe(true)
}

describe('renaming an organization', () => {
  it('changes the display name for an owner or admin, and never the slug', async () => {
    const { owner, admin, slug } = await team()
    await renameOrganization(owner.headers, { tenant: slug, name: '  By owner  ' })
    await expect(getTenant(owner.headers, { tenant: slug })).resolves.toMatchObject({
      name: 'By owner',
      slug,
    })
    await renameOrganization(admin.headers, { tenant: slug, name: 'By admin' })
    await expect(getTenant(admin.headers, { tenant: slug })).resolves.toMatchObject({
      name: 'By admin',
      slug,
    })
  })

  it('gives a member 403 and changes nothing', async () => {
    const { member, owner, slug } = await team()
    const before = await getTenant(owner.headers, { tenant: slug })
    await expectStatus(() => renameOrganization(member.headers, { tenant: slug, name: 'No' }), 403)
    await expect(getTenant(owner.headers, { tenant: slug })).resolves.toMatchObject({
      name: before.name,
    })
  })

  it("gives a non-member 404 on another tenant's organization, and an unknown slug 404", async () => {
    const { outsider, slug } = await team()
    await expectStatus(
      () => renameOrganization(outsider.headers, { tenant: slug, name: 'No' }),
      404,
    )
    await expectStatus(
      () => renameOrganization(outsider.headers, { tenant: 'no-such-org', name: 'No' }),
      404,
    )
  })

  it('refuses a slug or organizationId in the input', async () => {
    const { owner, slug } = await team()
    for (const extra of [{ slug: 'other' }, { organizationId: 'x' }])
      await expectStatus(
        () => renameOrganization(owner.headers, { tenant: slug, name: 'N', ...extra }),
        400,
      )
    await expectStatus(() => renameOrganization(owner.headers, { tenant: slug, name: '  ' }), 400)
  })

  it('leaves the existing direct HTTP slug update as it was', async () => {
    const { owner, orgId, slug } = await team()
    const next = `${slug}-moved`
    const res = await authPost(
      '/organization/update',
      { organizationId: orgId, data: { slug: next } },
      randomIp(),
      owner,
    )
    expect(res.ok).toBe(true)
    await expect(getTenant(owner.headers, { tenant: next })).resolves.toMatchObject({ slug: next })
  })
})

describe('transferring ownership', () => {
  it('makes a member an owner and the caller an admin', async () => {
    const { owner, member, orgId, slug } = await team()
    const memberId = await memberIdOf(orgId, member)
    await transferOwnership(owner.headers, { tenant: slug, memberId })
    expect(await roleOf(orgId, member)).toBe('owner')
    expect(await roleOf(orgId, owner)).toBe('admin')
  })

  it('gives an admin or member 403 and changes nothing', async () => {
    const { owner, admin, member, orgId, slug } = await team()
    const memberId = await memberIdOf(orgId, member)
    await expectStatus(() => transferOwnership(admin.headers, { tenant: slug, memberId }), 403)
    await expectStatus(() => transferOwnership(member.headers, { tenant: slug, memberId }), 403)
    expect(await roleOf(orgId, owner)).toBe('owner')
    expect(await roleOf(orgId, member)).toBe('member')
  })

  it("gives 404 for another tenant's member or an unknown id, before the role check", async () => {
    const { owner, member, outsider, orgId, slug, otherSlug } = await team()
    const foreign = await memberIdOf(await orgIdOf(otherSlug), outsider)
    await expectStatus(
      () => transferOwnership(owner.headers, { tenant: slug, memberId: foreign }),
      404,
    )
    await expectStatus(
      () => transferOwnership(member.headers, { tenant: slug, memberId: foreign }),
      404,
    )
    await expectStatus(
      () => transferOwnership(owner.headers, { tenant: slug, memberId: 'nope' }),
      404,
    )
    await expectStatus(
      () => transferOwnership(outsider.headers, { tenant: slug, memberId: 'nope' }),
      404,
    )
    expect(await roleOf(orgId, owner)).toBe('owner')
  })

  it('refuses choosing yourself', async () => {
    const { owner, orgId, slug } = await team()
    const memberId = await memberIdOf(orgId, owner)
    await expectStatus(() => transferOwnership(owner.headers, { tenant: slug, memberId }), 400)
    expect(await roleOf(orgId, owner)).toBe('owner')
  })

  it('with a target already an owner, only demotes the caller (how a retry finishes)', async () => {
    const { a, b, orgId, slug, memberB } = await twoOwners()
    await transferOwnership(a.headers, { tenant: slug, memberId: memberB })
    expect(await roleOf(orgId, a)).toBe('admin')
    expect(await roleOf(orgId, b)).toBe('owner')
  })
})

describe('leaving an organization', () => {
  it('lets an admin or member leave; the tenant then answers 404', async () => {
    const { admin, member, slug } = await team()
    for (const user of [admin, member]) {
      await leaveOrganization(user.headers, { tenant: slug })
      await expectStatus(() => getTenant(user.headers, { tenant: slug }), 404)
    }
  })

  it('refuses a sole owner with 409 and changes nothing; direct HTTP keeps 400', async () => {
    const { owner, orgId, slug } = await team()
    await expectStatus(() => leaveOrganization(owner.headers, { tenant: slug }), 409)
    const res = await authPost('/organization/leave', { organizationId: orgId }, randomIp(), owner)
    expect(res.status).toBe(400)
    expect(await roleOf(orgId, owner)).toBe('owner')
  })

  it('lets one of two owners leave', async () => {
    const { a, b, orgId, slug } = await twoOwners()
    await leaveOrganization(a.headers, { tenant: slug })
    expect(await roleOf(orgId, a)).toBeUndefined()
    expect(await roleOf(orgId, b)).toBe('owner')
  })

  it('gives a non-member 404', async () => {
    const { outsider, slug } = await team()
    await expectStatus(() => leaveOrganization(outsider.headers, { tenant: slug }), 404)
  })
})

describe('deleting an organization', () => {
  it('deletes for an owner who types the exact name', async () => {
    const { owner, slug, orgId } = await team()
    const { name } = await getTenant(owner.headers, { tenant: slug })
    await deleteOrganization(owner.headers, { tenant: slug, confirmName: name })
    expect((await sql('SELECT 1 FROM organization WHERE id = $1', [orgId])).rows).toEqual([])
    const viewer = await getViewer(owner.headers)
    expect(viewer!.organizations.map((o) => o.slug)).not.toContain(slug)
  })

  it('refuses a wrong or missing name with 400 and changes nothing', async () => {
    const { owner, slug, orgId } = await team()
    await expectStatus(
      () => deleteOrganization(owner.headers, { tenant: slug, confirmName: 'wrong' }),
      400,
    )
    await expectStatus(() => deleteOrganization(owner.headers, { tenant: slug }), 400)
    expect(await roleOf(orgId, owner)).toBe('owner')
  })

  it('gives an admin or member 403 and a non-member 404', async () => {
    const { owner, admin, member, outsider, slug } = await team()
    const { name } = await getTenant(owner.headers, { tenant: slug })
    const input = { tenant: slug, confirmName: name }
    await expectStatus(() => deleteOrganization(admin.headers, input), 403)
    await expectStatus(() => deleteOrganization(member.headers, input), 403)
    await expectStatus(() => deleteOrganization(outsider.headers, input), 404)
  })

  it('refuses a live subscription with 409, including one cancelled at period end', async () => {
    const { owner, slug, orgId } = await team()
    const { name } = await getTenant(owner.headers, { tenant: slug })
    await onPaidPlan(slug)
    const input = { tenant: slug, confirmName: name }
    await expectStatus(() => deleteOrganization(owner.headers, input), 409)
    await asOwner((q) =>
      q('UPDATE billing_subscription SET cancel_at_period_end = true WHERE organization_id = $1', [
        orgId,
      ]),
    )
    await expectStatus(() => deleteOrganization(owner.headers, input), 409)
    await asOwner((q) =>
      q(`UPDATE billing_subscription SET status = 'canceled' WHERE organization_id = $1`, [orgId]),
    )
    await deleteOrganization(owner.headers, input)
  })

  it('direct HTTP needs an owner session but no typed name, and has the billing protections', async () => {
    const { owner, admin, slug, orgId } = await team()
    const del = (user: TestUser) =>
      authPost('/organization/delete', { organizationId: orgId }, randomIp(), user)
    expect((await del(admin)).ok).toBe(false)
    await onPaidPlan(slug)
    expect((await del(owner)).status).toBe(409)
    await asOwner((q) =>
      q(`UPDATE billing_subscription SET status = 'canceled' WHERE organization_id = $1`, [orgId]),
    )
    expect((await del(owner)).ok).toBe(true)
  })
})

/** Runs `fn` on its own owner connection: outside any request's role and transaction. */
async function asOwner<T>(fn: (q: Query) => Promise<T>) {
  const { db, close } = await createDb(OWNER_URL)
  try {
    return await fn((text, params) => clientOf(db).query(text, params))
  } finally {
    await close()
  }
}

// Each race sets up several real accounts and repeats, so these take longer than the default.
describe('an organization keeps an owner (ADR-0043)', { timeout: 60_000 }, () => {
  const role = (orgId: string, as: TestUser, memberId: string) =>
    authPost(
      '/organization/update-member-role',
      { memberId, role: 'admin', organizationId: orgId },
      randomIp(),
      as,
    )
  const leave = (orgId: string, as: TestUser) =>
    authPost('/organization/leave', { organizationId: orgId }, randomIp(), as)
  const remove = (orgId: string, as: TestUser, memberId: string) =>
    authPost(
      '/organization/remove-member',
      { memberIdOrEmail: memberId, organizationId: orgId },
      randomIp(),
      as,
    )
  type Org = Awaited<ReturnType<typeof twoOwners>>
  const races: [string, (o: Org) => Promise<Response>[]][] = [
    [
      'two owners demote each other',
      (o) => [role(o.orgId, o.a, o.memberB), role(o.orgId, o.b, o.memberA)],
    ],
    [
      'two owners demote themselves',
      (o) => [role(o.orgId, o.a, o.memberA), role(o.orgId, o.b, o.memberB)],
    ],
    ['two owners leave', (o) => [leave(o.orgId, o.a), leave(o.orgId, o.b)]],
    [
      'two owners remove each other',
      (o) => [remove(o.orgId, o.a, o.memberB), remove(o.orgId, o.b, o.memberA)],
    ],
    [
      'one owner leaves while the other demotes themselves',
      (o) => [leave(o.orgId, o.a), role(o.orgId, o.b, o.memberB)],
    ],
  ]

  for (const [name, go] of races)
    it(`${name} over HTTP: one succeeds, one owner remains`, async () => {
      for (let i = 0; i < 5; i++) {
        const o = await twoOwners()
        const [x, y] = await Promise.all(go(o))
        expect([x!.ok, y!.ok].filter(Boolean).length).toBe(1)
        expect(await ownerCount(o.orgId)).toBe(1)
      }
    })

  it('two owners leaving through the app: the loser gets 409, not a server error', async () => {
    for (let i = 0; i < 5; i++) {
      const o = await twoOwners()
      const results = await Promise.allSettled([
        leaveOrganization(o.a.headers, { tenant: o.slug }),
        leaveOrganization(o.b.headers, { tenant: o.slug }),
      ])
      const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
      expect(refused).toHaveLength(1)
      expect(refused[0]!.reason).toMatchObject({ status: 409 })
      expect(await ownerCount(o.orgId)).toBe(1)
    }
  })

  /** Two open transactions at `level`, each demoting one owner, committing together. */
  async function demoteBoth(level: string) {
    const o = await twoOwners()
    const [c1, c2] = [await createDb(OWNER_URL), await createDb(OWNER_URL)]
    const [q1, q2] = [clientOf(c1.db), clientOf(c2.db)]
    try {
      await q1.query(`BEGIN ISOLATION LEVEL ${level}`)
      await q2.query(`BEGIN ISOLATION LEVEL ${level}`)
      await q1.query(`UPDATE member SET role = 'admin' WHERE id = $1`, [o.memberA])
      await q2.query(`UPDATE member SET role = 'admin' WHERE id = $1`, [o.memberB])
      const codes = (await Promise.allSettled([q1.query('COMMIT'), q2.query('COMMIT')])).map((r) =>
        r.status === 'fulfilled' ? 'ok' : (r.reason as { code: string }).code,
      )
      return { codes: codes.sort(), owners: await ownerCount(o.orgId) }
    } finally {
      await c1.close()
      await c2.close()
    }
  }

  it('holds at READ COMMITTED: the second commit sees the first and fails', async () => {
    await expect(demoteBoth('READ COMMITTED')).resolves.toEqual({
      codes: ['23514', 'ok'],
      owners: 1,
    })
  })

  it('refuses REPEATABLE READ and SERIALIZABLE, whose snapshots would miss the other commit', async () => {
    for (const level of ['REPEATABLE READ', 'SERIALIZABLE'])
      await expect(demoteBoth(level)).resolves.toEqual({ codes: ['25000', '25000'], owners: 2 })
  })

  it('holds with the check made immediate: the lock lasts until commit', async () => {
    const o = await twoOwners()
    const [c1, c2] = [await createDb(OWNER_URL), await createDb(OWNER_URL)]
    const [q1, q2] = [clientOf(c1.db), clientOf(c2.db)]
    try {
      for (const q of [q1, q2]) {
        await q.query('BEGIN')
        await q.query('SET CONSTRAINTS ALL IMMEDIATE')
      }
      await q1.query(`UPDATE member SET role = 'admin' WHERE id = $1`, [o.memberA])
      const second = q2.query(`UPDATE member SET role = 'admin' WHERE id = $1`, [o.memberB])
      await q1.query('COMMIT')
      await expect(second).rejects.toMatchObject({ code: '23514' })
      await q2.query('ROLLBACK')
      expect(await ownerCount(o.orgId)).toBe(1)
    } finally {
      await c1.close()
      await c2.close()
    }
  })

  it('a concurrent promotion can only cause a refusal, never no owner', async () => {
    const t = await team()
    const [c1, c2] = [await createDb(OWNER_URL), await createDb(OWNER_URL)]
    const [q1, q2] = [clientOf(c1.db), clientOf(c2.db)]
    try {
      await q1.query('BEGIN')
      await q2.query('BEGIN')
      await q1.query(`UPDATE member SET role = 'owner' WHERE id = $1`, [
        await memberIdOf(t.orgId, t.member),
      ])
      await q2.query(`UPDATE member SET role = 'admin' WHERE id = $1`, [
        await memberIdOf(t.orgId, t.owner),
      ])
      await expect(q2.query('COMMIT')).rejects.toMatchObject({ code: '23514' })
      await q1.query('COMMIT')
      expect(await ownerCount(t.orgId)).toBe(2)
    } finally {
      await c1.close()
      await c2.close()
    }
  })

  it('applies to raw SQL as the runtime role, and to a sole owner deleted by cascade', async () => {
    const { owner, orgId } = await team()
    await expect(
      sql(`UPDATE member SET role = 'member' WHERE organization_id = $1 AND user_id = $2`, [
        orgId,
        owner.userId,
      ]),
    ).rejects.toThrow()
    await expect(
      asOwner((q) => q('DELETE FROM "user" WHERE id = $1', [owner.userId])),
    ).rejects.toMatchObject({ code: '23514' })
    expect(await roleOf(orgId, owner)).toBe('owner')
  })

  it('lets the organization go in the same transaction as its owners', async () => {
    const { owner, orgId } = await team()
    await asOwner(async (q) => {
      await q('BEGIN')
      await q('DELETE FROM "user" WHERE id = $1', [owner.userId])
      await q('DELETE FROM organization WHERE id = $1', [orgId])
      await q('COMMIT')
    })
    expect((await sql('SELECT 1 FROM organization WHERE id = $1', [orgId])).rows).toEqual([])
  })

  it("a demotion racing Better Auth's organization delete leaves a consistent result", async () => {
    for (let i = 0; i < 5; i++) {
      const o = await twoOwners()
      const [demote, del] = await Promise.all([
        role(o.orgId, o.b, o.memberB),
        authPost('/organization/delete', { organizationId: o.orgId }, randomIp(), o.a),
      ])
      const exists = (await sql('SELECT 1 FROM organization WHERE id = $1', [o.orgId])).rows.length
      if (del.ok) expect(exists).toBe(0)
      else expect(await ownerCount(o.orgId)).toBeGreaterThanOrEqual(1)
      expect(demote.status).toBeLessThan(600)
    }
  })

  it('is a deferred definer trigger with a pinned search_path that the runtime role cannot run', async () => {
    const { rows } = await sql(
      `SELECT t.tgdeferrable, t.tginitdeferred, t.tgenabled, p.prosecdef, p.proconfig,
              pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS runtime_execute
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgname = 'member_keeps_owner' AND NOT t.tgisinternal`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tgdeferrable: true,
      tginitdeferred: true,
      tgenabled: 'O',
      prosecdef: true,
      runtime_execute: false,
      proconfig: ['search_path=pg_catalog, pg_temp'],
    })
    expect(rows[0]!.owner).not.toBe('app_runtime')
  })
})

describe('a deletion and a subscription (ADR-0043)', { timeout: 60_000 }, () => {
  const quiet = { subscriptions: [], hasPendingCheckout: false }
  const providerWith = (
    state: Awaited<ReturnType<BillingProvider['accountState']>> | Error = quiet,
  ) =>
    ({
      checkout: vi.fn(async () => 'https://checkout.example/x'),
      portal: vi.fn(async () => 'https://portal.example/x'),
      accountState: vi.fn(async () => {
        if (state instanceof Error) throw state
        return state
      }),
    }) satisfies BillingProvider
  const begin = (orgId: string, provider: BillingProvider | null) =>
    withDb((db) => beginOrganizationDeletion(db, orgId, provider))
  const buy = (user: TestUser, tenant: string, provider: BillingProvider) =>
    startCheckout(user.headers, { tenant, price: 'pro_monthly' }, provider)
  const age = (orgId: string, column: string) =>
    asOwner((q) =>
      q(
        `UPDATE billing_checkout_gate SET ${column} = now() - interval '6 minutes'
          WHERE organization_id = $1`,
        [orgId],
      ),
    )

  it('a new checkout is refused once a deletion has begun, before reaching the provider', async () => {
    const { owner, slug, orgId } = await team()
    expect(await begin(orgId, providerWith())).toBeNull()
    const provider = providerWith()
    await expectStatus(() => buy(owner, slug, provider), 409)
    expect(provider.checkout).not.toHaveBeenCalled()
  })

  it('a deletion is refused just after a checkout started, even with nothing at the provider yet', async () => {
    const { owner, slug, orgId } = await team()
    const provider = providerWith()
    await buy(owner, slug, provider)
    expect(await begin(orgId, providerWith())).toMatch(/just started/)
    await age(orgId, 'checkout_started_at')
    expect(await begin(orgId, providerWith())).toBeNull()
  })

  it('of a checkout and a deletion claiming together, exactly one wins', async () => {
    for (let i = 0; i < 10; i++) {
      const { owner, slug, orgId } = await team()
      const [checkout, deletion] = await Promise.allSettled([
        buy(owner, slug, providerWith()),
        begin(orgId, providerWith()),
      ])
      const checkoutWon = checkout.status === 'fulfilled'
      const deletionWon = deletion.status === 'fulfilled' && deletion.value === null
      expect(checkoutWon).not.toBe(deletionWon)
    }
  })

  it('an open checkout session blocks the deletion, and checkouts stay available', async () => {
    const { owner, slug, orgId } = await team()
    expect(
      await begin(orgId, providerWith({ subscriptions: [], hasPendingCheckout: true })),
    ).toMatch(/still open/)
    await expect(buy(owner, slug, providerWith())).resolves.toBeDefined()
  })

  it('a subscription the provider knows but no webhook delivered blocks the deletion', async () => {
    const { orgId } = await team()
    const state = { subscriptions: [{ status: 'active' as const }], hasPendingCheckout: false }
    expect(await begin(orgId, providerWith(state))).toMatch(/active subscription/)
    const ended = { subscriptions: [{ status: 'canceled' as const }], hasPendingCheckout: false }
    expect(await begin(orgId, providerWith(ended))).toBeNull()
  })

  it('an unreadable provider refuses the deletion and releases the claim', async () => {
    const { owner, slug, orgId } = await team()
    await expect(begin(orgId, providerWith(new Error('down')))).rejects.toThrow('down')
    await expect(buy(owner, slug, providerWith())).resolves.toBeDefined()
  })

  it("a crashed deletion's claim expires, so checkouts come back", async () => {
    const { owner, slug, orgId } = await team()
    expect(await begin(orgId, providerWith())).toBeNull()
    await expectStatus(() => buy(owner, slug, providerWith()), 409)
    await age(orgId, 'deletion_started_at')
    await expect(buy(owner, slug, providerWith())).resolves.toBeDefined()
  })

  it('a retry after a failed delete proceeds, without waiting out its own claim', async () => {
    const { orgId } = await team()
    expect(await begin(orgId, providerWith())).toBeNull()
    expect(await begin(orgId, providerWith())).toBeNull()
  })

  it("a second deleter's refusal leaves the first's claim in place", async () => {
    const { owner, slug, orgId } = await team()
    expect(await begin(orgId, providerWith())).toBeNull()
    await expect(begin(orgId, providerWith(new Error('down')))).rejects.toThrow('down')
    await expectStatus(() => buy(owner, slug, providerWith()), 409)
  })

  it("one organization's claim doesn't touch another's", async () => {
    const { outsider, otherSlug, orgId } = await team()
    expect(await begin(orgId, providerWith())).toBeNull()
    await expect(buy(outsider, otherSlug, providerWith())).resolves.toBeDefined()
  })

  it('the claim row goes with the organization', async () => {
    const { owner, slug, orgId } = await team()
    await buy(owner, slug, providerWith())
    await age(orgId, 'checkout_started_at')
    const { name } = await getTenant(owner.headers, { tenant: slug })
    await deleteOrganization(owner.headers, { tenant: slug, confirmName: name })
    const { rows } = await asOwner((q) =>
      q('SELECT 1 FROM billing_checkout_gate WHERE organization_id = $1', [orgId]),
    )
    expect(rows).toEqual([])
  })

  it("counts Polar's open, confirmed and recently succeeded checkouts as pending", () => {
    const now = Date.parse('2026-10-31T12:00:00Z')
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
    const checkout = (status: string, fields = {}) => ({
      status,
      expires_at: at(30),
      created_at: at(-60),
      modified_at: null,
      ...fields,
    })
    expect(isPendingCheckout(checkout('open'), now)).toBe(true)
    expect(isPendingCheckout(checkout('open', { expires_at: at(-1) }), now)).toBe(false)
    expect(isPendingCheckout(checkout('confirmed', { expires_at: at(-1) }), now)).toBe(true)
    expect(isPendingCheckout(checkout('succeeded', { modified_at: at(-5) }), now)).toBe(true)
    expect(isPendingCheckout(checkout('succeeded', { modified_at: at(-11) }), now)).toBe(false)
    expect(isPendingCheckout(checkout('expired'), now)).toBe(false)
    expect(isPendingCheckout(checkout('failed'), now)).toBe(false)
  })
})
