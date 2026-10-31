import { createAuth } from '@saas-foundation/auth'
import { APIError } from 'better-auth/api'
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb, findOrganizationBySlug, type Db } from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { startCheckout } from '../src/modules/billing/service'
import { isLive } from '../src/modules/billing/policy'
import { readAccountState } from '../src/modules/billing/providers/polar'
import {
  CheckoutNotCreated,
  PriceNotFound,
  type BillingProvider,
} from '../src/modules/billing/provider'
import {
  deleteOrganization,
  getTenant,
  getViewer,
  leaveOrganization,
  refusal,
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
import { testBotProtection } from './turnstile-fake'

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
        AND role ~ '(^|,)\\s*owner\\s*(,|$)'`,
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

  it('takes 120 characters and refuses 121', async () => {
    const { owner, slug } = await team()
    await renameOrganization(owner.headers, { tenant: slug, name: 'x'.repeat(120) })
    await expectStatus(
      () => renameOrganization(owner.headers, { tenant: slug, name: 'x'.repeat(121) }),
      400,
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

  it('leaves the existing direct HTTP slug update as it was, for an owner and an admin', async () => {
    const { owner, admin, orgId, slug } = await team()
    for (const [user, next] of [
      [owner, `${slug}-o`],
      [admin, `${slug}-a`],
    ] as const) {
      const res = await authPost(
        '/organization/update',
        { organizationId: orgId, data: { slug: next } },
        randomIp(),
        user,
      )
      expect(res.ok).toBe(true)
      await expect(getTenant(user.headers, { tenant: next })).resolves.toMatchObject({ slug: next })
    }
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

describe('a transfer that fails part-way', { timeout: 60_000 }, () => {
  // Refuses an update of the marked member rows as the guard does, so the app's mapping runs.
  beforeAll(() =>
    asOwner((q) =>
      q(`CREATE SCHEMA IF NOT EXISTS test_transfer_fault;
         CREATE TABLE IF NOT EXISTS test_transfer_fault.failing (member_id text PRIMARY KEY);
         CREATE OR REPLACE FUNCTION test_transfer_fault.fail() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
         BEGIN
           IF EXISTS (SELECT FROM test_transfer_fault.failing f WHERE f.member_id = OLD.id) THEN
             RAISE EXCEPTION 'injected' USING ERRCODE = '23514', CONSTRAINT = 'member_keeps_owner';
           END IF;
           RETURN NEW;
         END $$;
         DROP TRIGGER IF EXISTS test_transfer_fault ON public.member;
         CREATE TRIGGER test_transfer_fault BEFORE UPDATE ON public.member
           FOR EACH ROW EXECUTE FUNCTION test_transfer_fault.fail();`),
    ),
  )
  afterAll(() =>
    asOwner((q) =>
      q(`DROP TRIGGER IF EXISTS test_transfer_fault ON public.member;
         DROP SCHEMA IF EXISTS test_transfer_fault CASCADE;`),
    ),
  )
  const failOn = (memberId: string) =>
    asOwner((q) => q('INSERT INTO test_transfer_fault.failing VALUES ($1)', [memberId]))
  const clear = (memberId: string) =>
    asOwner((q) => q('DELETE FROM test_transfer_fault.failing WHERE member_id = $1', [memberId]))

  it('a failed promotion changes nothing', async () => {
    const { owner, member, orgId, slug } = await team()
    const memberId = await memberIdOf(orgId, member)
    await failOn(memberId)
    await expect(
      transferOwnership(owner.headers, { tenant: slug, memberId }),
    ).rejects.toMatchObject({ status: 409 })
    await clear(memberId)
    expect(await roleOf(orgId, owner)).toBe('owner')
    expect(await roleOf(orgId, member)).toBe('member')
  })

  it('a failed demotion leaves two owners and says so, and a retry finishes', async () => {
    const { owner, member, orgId, slug } = await team()
    const memberId = await memberIdOf(orgId, member)
    const ownerRow = await memberIdOf(orgId, owner)
    await failOn(ownerRow)
    const input = { tenant: slug, memberId }
    const failed = await transferOwnership(owner.headers, input).catch((e: unknown) => e)
    await clear(ownerRow)
    expect(failed).toMatchObject({ status: 409 })
    expect((failed as Error).message).toMatch(/still an owner/)
    expect(await roleOf(orgId, member)).toBe('owner')
    expect(await roleOf(orgId, owner)).toBe('owner')
    await transferOwnership(owner.headers, input)
    expect(await roleOf(orgId, owner)).toBe('admin')
    expect(await roleOf(orgId, member)).toBe('owner')
  })
})

describe('what a refused change tells the caller', () => {
  const apiError = (status: 'BAD_REQUEST' | 'FORBIDDEN' | 'UNAUTHORIZED', code: string) =>
    new APIError(status, { code, message: code })

  it('maps each known refusal by name', () => {
    for (const [e, status] of [
      [apiError('UNAUTHORIZED', 'UNAUTHORIZED'), 401],
      [apiError('BAD_REQUEST', 'MEMBER_NOT_FOUND'), 404],
      [apiError('BAD_REQUEST', 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION'), 404],
      [apiError('FORBIDDEN', 'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER'), 403],
      [apiError('BAD_REQUEST', 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER'), 409],
      [new APIError('CONFLICT', { message: 'billing' }), 409],
      [new APIError('SERVICE_UNAVAILABLE', { message: 'billing' }), 503],
    ] as const)
      expect(refusal(e)).toMatchObject({ status })
  })

  it('never turns an unexpected error into a conflict', () => {
    const unknown = apiError('BAD_REQUEST', 'SOMETHING_NEW')
    expect(() => refusal(unknown)).toThrow(unknown)
    const outage = new Error('connection lost')
    expect(() => refusal(outage)).toThrow(outage)
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
        // The loser: the guard's 500, or Better Auth's own answer if it already saw the first.
        const loser = x!.ok ? y! : x!
        expect([400, 403, 500]).toContain(loser.status)
        const body = await loser.text()
        for (const leak of ['no owner', 'member_keeps_owner', 'update "member"', 'delete from'])
          expect(body).not.toContain(leak)
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

  it('applies when an owner row moves to another organization', async () => {
    const { owner, orgId, outsider, otherSlug } = await team()
    const ownerRow = await memberIdOf(orgId, owner)
    expect(outsider.userId).toBeDefined()
    await expect(
      asOwner((q) =>
        orgIdOf(otherSlug).then((other) =>
          q('UPDATE member SET organization_id = $1 WHERE id = $2', [other, ownerRow]),
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' })
    expect(await roleOf(orgId, owner)).toBe('owner')
  })

  it('reads a role as the capability matrix does', async () => {
    const { owner, member, orgId } = await team()
    const ownerRow = await memberIdOf(orgId, owner)
    const memberRow = await memberIdOf(orgId, member)
    const setRole = (id: string, role: string) =>
      asOwner((q) => q('UPDATE member SET role = $1 WHERE id = $2', [role, id]))
    // Not an owner to the app, so it can't be the owner that remains.
    await setRole(memberRow, 'ow ner')
    await expect(setRole(ownerRow, 'admin')).rejects.toMatchObject({ code: '23514' })
    // An owner to the app, however it's padded, so the guard sees it go.
    await setRole(memberRow, 'member')
    await setRole(ownerRow, 'admin,\towner ')
    await expect(setRole(ownerRow, 'admin')).rejects.toMatchObject({ code: '23514' })
    expect(await ownerCount(orgId)).toBe(1)
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
  type State = Awaited<ReturnType<BillingProvider['accountState']>>
  const providerWith = (state: State | Error = quiet) =>
    ({
      checkout: vi.fn(async () => 'https://checkout.example/x'),
      portal: vi.fn(async () => 'https://portal.example/x'),
      accountState: vi.fn(async () => {
        if (state instanceof Error) throw state
        return state
      }),
    }) satisfies BillingProvider
  /** A promise the test settles, so a request stays paused exactly as long as the test wants. */
  function paused<T>() {
    let resume: (value: T) => void = () => {}
    let fail: (e: Error) => void = () => {}
    const promise = new Promise<T>((res, rej) => {
      resume = res
      fail = rej
    })
    return { promise, resume, fail }
  }
  const begin = (orgId: string, provider: BillingProvider | null) =>
    withDb((db) => beginOrganizationDeletion(db, orgId, provider))
  const buy = (user: TestUser, tenant: string, provider: BillingProvider) =>
    startCheckout(user.headers, { tenant, price: 'pro_monthly' }, provider)

  it('a checkout paused on its way to the provider blocks the deletion for as long as it lasts', async () => {
    const { owner, slug, orgId } = await team()
    const session = paused<string>()
    const provider = providerWith()
    provider.checkout.mockImplementation(() => session.promise)
    const attempt = buy(owner, slug, provider)
    await vi.waitFor(() => expect(provider.checkout).toHaveBeenCalled())
    // However long this takes: no timestamp is stored, so nothing here can expire.
    expect(await begin(orgId, providerWith())).toMatch(/hasn't finished/)
    expect(await begin(orgId, providerWith())).toMatch(/hasn't finished/)
    session.resume('https://checkout.example/late')
    await expect(attempt).resolves.toEqual({ url: 'https://checkout.example/late' })
    // Finished: the session is at the provider now, so its state decides.
    const open = { subscriptions: [], hasPendingCheckout: true }
    expect(await begin(orgId, providerWith(open))).toMatch(/still open/)
    expect(await begin(orgId, providerWith())).toBeNull()
  })

  it('a deletion paused on the provider cannot go on after a checkout started meanwhile', async () => {
    const { owner, slug, orgId } = await team()
    const read = paused<State>()
    const stalled = providerWith()
    stalled.accountState.mockImplementation(() => read.promise)
    const deletion = begin(orgId, stalled)
    await vi.waitFor(() => expect(stalled.accountState).toHaveBeenCalled())
    await expect(buy(owner, slug, providerWith())).resolves.toBeDefined()
    // Its read says nothing is there: it was true when taken, and it's stale now.
    read.resume(quiet)
    await expect(deletion).resolves.toMatch(/just started/)
    await expect(buy(owner, slug, providerWith())).resolves.toBeDefined()
  })

  it('a deletion paused on the provider cannot go on while that checkout is still in flight', async () => {
    const { owner, slug, orgId } = await team()
    const read = paused<State>()
    const stalled = providerWith()
    stalled.accountState.mockImplementation(() => read.promise)
    const deletion = begin(orgId, stalled)
    await vi.waitFor(() => expect(stalled.accountState).toHaveBeenCalled())
    const session = paused<string>()
    const buying = providerWith()
    buying.checkout.mockImplementation(() => session.promise)
    const attempt = buy(owner, slug, buying)
    await vi.waitFor(() => expect(buying.checkout).toHaveBeenCalled())
    read.resume(quiet)
    await expect(deletion).resolves.toMatch(/just started/)
    session.resume('https://checkout.example/x')
    await expect(attempt).resolves.toBeDefined()
  })

  it('of a checkout and a deletion racing, never both', async () => {
    for (let i = 0; i < 10; i++) {
      const { owner, slug, orgId } = await team()
      const [checkout, deletion] = await Promise.allSettled([
        buy(owner, slug, providerWith()),
        begin(orgId, providerWith()),
      ])
      const checkoutWon = checkout.status === 'fulfilled'
      const deletionWon = deletion.status === 'fulfilled' && deletion.value === null
      expect(checkoutWon && deletionWon).toBe(false)
      if (!checkoutWon) expect(checkout.reason).toMatchObject({ status: 409 })
    }
  })

  it('a checkout whose outcome is unknown blocks the deletion until someone resolves it', async () => {
    const { owner, slug, orgId } = await team()
    const lost = providerWith()
    lost.checkout.mockRejectedValue(new Error('connection lost after sending'))
    await expect(buy(owner, slug, lost)).rejects.toThrow('connection lost')
    expect(await begin(orgId, providerWith())).toMatch(/outcome is unknown/)
    // Another checkout still works; the unknown one stays counted.
    await expect(buy(owner, slug, providerWith())).resolves.toBeDefined()
    expect(await begin(orgId, providerWith())).toMatch(/outcome is unknown/)
    // The runbook's step, after checking the provider.
    await asOwner((q) =>
      q('UPDATE billing_checkout_gate SET checkouts_in_flight = 0 WHERE organization_id = $1', [
        orgId,
      ]),
    )
    expect(await begin(orgId, providerWith())).toBeNull()
  })

  it('a checkout that can never exist at the provider does not block the deletion', async () => {
    for (const error of [new CheckoutNotCreated('refused'), new PriceNotFound('no price')]) {
      const { owner, slug, orgId } = await team()
      const refused = providerWith()
      refused.checkout.mockRejectedValue(error)
      await expect(buy(owner, slug, refused)).rejects.toBeDefined()
      expect(await begin(orgId, providerWith())).toBeNull()
    }
  })

  it('once committed, no checkout starts, however late it arrives, and a retry goes ahead', async () => {
    const { owner, slug, orgId } = await team()
    expect(await begin(orgId, providerWith())).toBeNull()
    const provider = providerWith()
    await expectStatus(() => buy(owner, slug, provider), 409)
    expect(provider.checkout).not.toHaveBeenCalled()
    // A failed delete's retry: the checks passed, nothing can have started, the provider's
    // customer may already be gone.
    const unreadable = providerWith(new Error('down'))
    expect(await begin(orgId, unreadable)).toBeNull()
    expect(unreadable.accountState).not.toHaveBeenCalled()
  })

  it('a refused deletion leaves checkouts working and needs nothing released', async () => {
    const { owner, slug, orgId } = await team()
    const open = { subscriptions: [], hasPendingCheckout: true }
    expect(await begin(orgId, providerWith(open))).toMatch(/still open/)
    await expect(begin(orgId, providerWith(new Error('down')))).rejects.toThrow('down')
    await expect(buy(owner, slug, providerWith())).resolves.toBeDefined()
  })

  it('a subscription the provider knows but no webhook delivered blocks the deletion', async () => {
    const { orgId } = await team()
    const state = { subscriptions: [{ status: 'active' as const }], hasPendingCheckout: false }
    expect(await begin(orgId, providerWith(state))).toMatch(/active subscription/)
    const ended = { subscriptions: [{ status: 'canceled' as const }], hasPendingCheckout: false }
    expect(await begin(orgId, providerWith(ended))).toBeNull()
  })

  it("one organization's attempt or commit doesn't touch another's", async () => {
    const { owner, slug, outsider, otherSlug, orgId } = await team()
    const session = paused<string>()
    const provider = providerWith()
    provider.checkout.mockImplementation(() => session.promise)
    const attempt = buy(outsider, otherSlug, provider)
    await vi.waitFor(() => expect(provider.checkout).toHaveBeenCalled())
    expect(await begin(orgId, providerWith())).toBeNull()
    await expectStatus(() => buy(owner, slug, providerWith()), 409)
    session.resume('https://checkout.example/x')
    await expect(attempt).resolves.toBeDefined()
  })

  it('the gate row goes with the organization', async () => {
    const { owner, slug, orgId } = await team()
    await buy(owner, slug, providerWith())
    const { name } = await getTenant(owner.headers, { tenant: slug })
    await deleteOrganization(owner.headers, { tenant: slug, confirmName: name })
    const { rows } = await asOwner((q) =>
      q('SELECT 1 FROM billing_checkout_gate WHERE organization_id = $1', [orgId]),
    )
    expect(rows).toEqual([])
  })

  describe('through Better Auth, on every path', () => {
    const deleteVia = (as: TestUser, orgId: string, beginDeletion: () => Promise<string | null>) =>
      withDb((db) =>
        createAuth({
          db,
          secret: env.BETTER_AUTH_SECRET,
          baseURL: env.BETTER_AUTH_URL,
          allowSignUp: () => true,
          requireEmailVerification: true,
          botProtection: testBotProtection,
          sendEmail: async () => {},
          billing: {
            memberLimit: async () => null,
            blocksDeletion: async () => false,
            beginDeletion,
          },
        }).handler(
          new Request(`${env.BETTER_AUTH_URL}/api/auth/organization/delete`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: env.BETTER_AUTH_URL,
              'cf-connecting-ip': randomIp(),
              cookie: as.headers.get('cookie')!,
            },
            body: JSON.stringify({ organizationId: orgId }),
          }),
        ),
      )
    const exists = async (orgId: string) =>
      (await sql('SELECT 1 FROM organization WHERE id = $1', [orgId])).rows.length === 1

    it('a refusal answers 409 with its message and deletes nothing', async () => {
      const { owner, orgId } = await team()
      const res = await deleteVia(owner, orgId, async () => 'A checkout is still open.')
      expect(res.status).toBe(409)
      expect(await res.text()).toContain('A checkout is still open.')
      expect(await exists(orgId)).toBe(true)
    })

    it('an unreadable provider answers 503 and deletes nothing', async () => {
      const { owner, orgId } = await team()
      const res = await deleteVia(owner, orgId, async () => {
        throw new Error('provider down: secret detail')
      })
      expect(res.status).toBe(503)
      expect(await res.text()).not.toContain('secret detail')
      expect(await exists(orgId)).toBe(true)
    })

    it('runs only after the permission check: an admin never reaches it', async () => {
      const { admin, orgId } = await team()
      const beginDeletion = vi.fn(async () => null)
      expect((await deleteVia(admin, orgId, beginDeletion)).ok).toBe(false)
      expect(beginDeletion).not.toHaveBeenCalled()
      expect(await exists(orgId)).toBe(true)
    })
  })
})

describe("reading Polar's state for a deletion (ADR-0043)", () => {
  type Checkout = { id: string; status: string }
  type Subscription = { status: string; checkout_id: string | null }
  async function* each<T>(items: T[]) {
    yield* items
  }
  const read = (checkouts: Checkout[], subscriptions: Subscription[] = []) =>
    readAccountState({ checkouts: () => each(checkouts), subscriptions: () => each(subscriptions) })

  it('anything that could still complete blocks, without looking at a clock', async () => {
    for (const status of ['open', 'confirmed', 'failed', 'some_future_status'])
      await expect(read([{ id: 'c', status }])).resolves.toMatchObject({ hasPendingCheckout: true })
  })

  it('only an expired session is finished without a subscription', async () => {
    await expect(read([{ id: 'c', status: 'expired' }])).resolves.toEqual({
      subscriptions: [],
      hasPendingCheckout: false,
    })
  })

  it('a succeeded session blocks until its own subscription is listed, however long ago it succeeded', async () => {
    const paid = { id: 'c1', status: 'succeeded' }
    await expect(read([paid])).resolves.toMatchObject({ hasPendingCheckout: true })
    await expect(
      read([paid], [{ status: 'canceled', checkout_id: 'another-session' }]),
    ).resolves.toMatchObject({ hasPendingCheckout: true })
    await expect(read([paid], [{ status: 'active', checkout_id: 'c1' }])).resolves.toEqual({
      subscriptions: [{ status: 'active' }],
      hasPendingCheckout: false,
    })
  })

  it('reads subscriptions only after every session, so a payment between the reads is seen', async () => {
    // The session is open when read, and payment completes while this request is paused: it must
    // already have refused, not gone on to a subscription list that predates the payment.
    const subscriptions = vi.fn(() => each<Subscription>([]))
    await expect(
      readAccountState({ checkouts: () => each([{ id: 'c', status: 'open' }]), subscriptions }),
    ).resolves.toMatchObject({ hasPendingCheckout: true })
    expect(subscriptions).not.toHaveBeenCalled()

    // Paid before the session is read: the subscription list, read later, must show it.
    const order: string[] = []
    const result = await readAccountState({
      checkouts: async function* () {
        order.push('checkouts:start')
        yield { id: 'c', status: 'succeeded' }
        order.push('checkouts:end')
      },
      subscriptions: async function* () {
        order.push('subscriptions:start')
        yield { status: 'active', checkout_id: 'c' }
      },
    })
    expect(order).toEqual(['checkouts:start', 'checkouts:end', 'subscriptions:start'])
    expect(result).toEqual({ subscriptions: [{ status: 'active' }], hasPendingCheckout: false })
  })

  it('an unknown subscription status counts as live, as in the webhook', async () => {
    const { subscriptions } = await read([], [{ status: 'some_future_status', checkout_id: null }])
    expect(subscriptions).toEqual([{ status: 'incomplete' }])
    expect(isLive(subscriptions[0]!)).toBe(true)
  })
})
