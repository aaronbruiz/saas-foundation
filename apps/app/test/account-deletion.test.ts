import { createAuth } from '@saas-foundation/auth'
import { DeleteAccountInput } from '@saas-foundation/contracts'
import {
  closeBillingAccess,
  createDb,
  deactivateAccount,
  findOrganizationBySlug,
  gatedMemberWrite,
  reopenBillingAccess,
  type Db,
} from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBillingPortal, startCheckout } from '../src/modules/billing/service'
import { MemberWriteUnknown, type BillingProvider } from '../src/modules/billing/provider'
import { memberWrite } from '../src/modules/billing/providers/polar'
import { createProject } from '../src/modules/projects/service'
import {
  acceptInvitation,
  revokeInvitation,
  createOrganization,
  inviteMember,
} from '../src/modules/organizations/service'
import { gatedBillingMembers, reportAccountDeleted } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { redact } from '../src/server/log'
import {
  authPost,
  createOrg,
  expectStatus,
  joinAs,
  onPaidPlan,
  PASSWORD,
  randomIp,
  signUp,
  type TestUser,
} from './helpers'
import { captchaHeader, testBotProtection } from './turnstile-fake'

// Self-service account deletion (ADR-0044): the account stops working at once, nothing can recover
// or change it, and billing access can't land after it. Requests are paused with promises the test
// settles or with a real database lock, so a schedule holds for as long as the test wants.

const OWNER_URL = 'postgres://app:app@localhost:5432/app_test'
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
const clientOf = (db: Db) => (rawDb(db) as unknown as { $client: { query: Query } }).$client
const sql = (text: string, params: unknown[] = []) =>
  withDb((db) => clientOf(db).query(text, params))

const asOwner = async <T>(fn: (q: { query: Query }) => Promise<T>) => {
  const conn = await createDb(OWNER_URL)
  try {
    return await fn(clientOf(conn.db))
  } finally {
    await conn.close()
  }
}

const orgIdOf = async (slug: string) => (await withDb((db) => findOrganizationBySlug(db, slug)))!.id
const count = async (table: string, column: string, value: string) =>
  (await sql(`SELECT count(*)::int AS n FROM "${table}" WHERE ${column} = $1`, [value])).rows[0]!
    .n as number
const gateOf = async (userId: string) =>
  (await sql('SELECT * FROM billing_access_gate WHERE user_id = $1', [userId])).rows[0]
const isDeactivated = async (userId: string) =>
  (await count('user_deletion', 'user_id', userId)) > 0

/** Until a statement containing `fragment` waits on a lock; asks over a fresh connection. */
const lockWaiter = (fragment: string) =>
  vi.waitFor(
    async () => {
      const { rows } = await asOwner((q) =>
        q.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE $1`,
          [`%${fragment}%`],
        ),
      )
      expect(rows[0]!.n).toBeGreaterThan(0)
    },
    { timeout: 20_000, interval: 50 },
  )

function paused<T = void>() {
  let resume: (value: T) => void = () => {}
  let fail: (e: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resume = res
    fail = rej
  })
  return { promise, resume, fail }
}

/** One Polar: what a write puts in, a revoke sees. Each step can be paused by the test. */
function fakePolar() {
  const present = new Set<string>()
  const key = (orgId: string, userId: string) => `${orgId}:${userId}`
  const before: {
    grant?: () => Promise<void>
    revoke?: (orgId: string, userId: string) => Promise<void>
  } = {}
  const calls = {
    grant: [] as string[],
    revoke: [] as { userId: string; successors: string[] }[],
  }
  return {
    present,
    before,
    calls,
    has: (orgId: string, userId: string) => present.has(key(orgId, userId)),
    add: (orgId: string, userId: string) => present.add(key(orgId, userId)),
    members: {
      revoke: async (
        orgId: string,
        userId: string,
        successors: { userId: string; email: string }[],
      ) => {
        calls.revoke.push({ userId, successors: successors.map((s) => s.userId) })
        await before.revoke?.(orgId, userId)
        for (const s of successors.slice(0, 1)) present.add(key(orgId, s.userId))
        present.delete(key(orgId, userId))
      },
      grant: async (orgId: string, manager: { userId: string; email: string }) => {
        calls.grant.push(manager.userId)
        await before.grant?.()
        present.add(key(orgId, manager.userId))
      },
      removeAccount: async () => {},
    },
  }
}

const emails: { kind: string; to: string }[] = []
afterEach(() => {
  emails.length = 0
})

/** The app's wiring with a fake Polar in the gate's place. */
const authWith = (db: Db, polar = fakePolar()) =>
  createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    allowSignUp: () => true,
    requireEmailVerification: true,
    botProtection: testBotProtection,
    sendEmail: async (email) => {
      emails.push({ kind: email.kind, to: email.to })
    },
    accountDeletion: { input: DeleteAccountInput, onDeactivated: reportAccountDeleted },
    billing: {
      memberLimit: async () => null,
      blocksDeletion: async () => false,
      members: gatedBillingMembers(db, polar.members),
    },
  })

const post = (path: string, body: unknown, as: TestUser | null, polar = fakePolar()) =>
  withDb((db) =>
    authWith(db, polar).handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: env.BETTER_AUTH_URL,
          'cf-connecting-ip': randomIp(),
          ...captchaHeader,
          ...(as && { cookie: as.headers.get('cookie')! }),
        },
        body: JSON.stringify(body),
      }),
    ),
  )

const deleteAccount = (as: TestUser, polar = fakePolar(), password = PASSWORD) =>
  post('/delete-account', { password }, as, polar)
type DeleteBody = {
  code?: string
  left?: string[]
  stillOwner?: string
  soleOwnerOf?: string[]
}
const bodyOf = async (res: Response) => (await res.json()) as DeleteBody

const memberIdOf = async (orgId: string, user: TestUser) =>
  (
    await sql('SELECT id FROM member WHERE organization_id = $1 AND user_id = $2', [
      orgId,
      user.userId,
    ])
  ).rows[0]!.id as string

/** `a` and `b` as the two owners of a new organization. */
async function twoOwners(a: TestUser, polar = fakePolar()) {
  const b = await signUp()
  const slug = await createOrg(b, 'two')
  const orgId = await orgIdOf(slug)
  await inviteAs(b, slug, a, 'admin')
  const memberId = await memberIdOf(orgId, a)
  const promoted = await post(
    '/organization/update-member-role',
    { memberId, role: 'owner', organizationId: orgId },
    b,
    polar,
  )
  expect(promoted.status).toBe(200)
  return { b, slug, orgId }
}

async function inviteAs(owner: TestUser, slug: string, user: TestUser, role: 'admin' | 'member') {
  const { invitationId } = await inviteMember(owner.headers, {
    tenant: slug,
    email: user.email,
    role,
  })
  await acceptInvitation(user.headers, { invitationId })
}

describe('deleting an account', { timeout: 60_000 }, () => {
  it('deactivates it: the old email and password answer as an unknown account, and sessions end', async () => {
    const user = await signUp()
    const unknown = await post(
      '/sign-in/email',
      { email: `nobody-${crypto.randomUUID()}@test.local`, password: PASSWORD },
      null,
    )
    const res = await deleteAccount(user)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('session_token=;')

    const after = await post('/sign-in/email', { email: user.email, password: PASSWORD }, null)
    expect(after.status).toBe(unknown.status)
    expect(await after.json()).toEqual(await unknown.json())
    expect((await post('/update-user', { name: 'x' }, user)).status).toBe(401)
    expect(await count('session', 'user_id', user.userId)).toBe(0)
  })

  it('invalidates every credential: password hash, OAuth tokens and reset links', async () => {
    const user = await signUp()
    await post('/request-password-reset', { email: user.email }, null)
    expect(await count('verification', 'value', user.userId)).toBe(1)
    await sql(
      `UPDATE account SET access_token = 'a', refresh_token = 'r', id_token = 'i'
                WHERE user_id = $1`,
      [user.userId],
    )
    expect((await deleteAccount(user)).status).toBe(200)

    const { rows } = await sql('SELECT * FROM account WHERE user_id = $1', [user.userId])
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      password: null,
      access_token: null,
      refresh_token: null,
      id_token: null,
    })
    expect(await count('verification', 'value', user.userId)).toBe(0)
    const { rows: tomb } = await sql('SELECT email FROM "user" WHERE id = $1', [user.userId])
    expect(tomb[0]!.email).toBe(`${user.userId}@deleted.invalid`)
  })

  it('a tombstone address can sign up as nobody and sign in as nobody', async () => {
    const user = await signUp()
    await deleteAccount(user)
    const tomb = `${user.userId}@deleted.invalid`
    const signIn = await post('/sign-in/email', { email: tomb, password: PASSWORD }, null)
    expect(signIn.status).toBe(401)
    const other = `someone-${crypto.randomUUID()}@deleted.invalid`
    await post('/sign-up/email', { email: other, password: PASSWORD, name: 'x' }, null)
    expect(await count('user', 'email', other)).toBe(0)
  })

  it("email change and Better Auth's own user deletion stay off", async () => {
    const user = await signUp()
    const change = await post('/change-email', { newEmail: `n-${user.email}` }, user)
    expect(change.status).toBeGreaterThanOrEqual(400)
    const remove = await post('/delete-user', { password: PASSWORD }, user)
    expect(remove.status).toBeGreaterThanOrEqual(400)
    const update = await post('/update-user', { email: `n-${user.email}` }, user)
    expect(update.status).toBe(400)
    expect(await count('user', 'id', user.userId)).toBe(1)
    expect(await count('user', 'email', user.email)).toBe(1)
  })

  it('a wrong password gets 401 and changes nothing; signed out gets 401', async () => {
    const user = await signUp()
    expect((await deleteAccount(user, fakePolar(), 'wrong-password-123')).status).toBe(401)
    expect(await isDeactivated(user.userId)).toBe(false)
    expect((await post('/delete-account', { password: PASSWORD }, null)).status).toBe(401)
  })

  it('invalid input gets 400: no user id or organization id is ever accepted', async () => {
    const user = await signUp()
    const res = await post('/delete-account', { password: PASSWORD, userId: 'x' }, user)
    expect(res.status).toBe(400)
    expect(await isDeactivated(user.userId)).toBe(false)
  })

  it('a sole owner gets 409 naming the organizations, and nothing changes, including billing', async () => {
    const user = await signUp()
    const slug = await createOrg(user, 'sole')
    const polar = fakePolar()
    const res = await deleteAccount(user, polar)
    expect(res.status).toBe(409)
    expect(await bodyOf(res)).toMatchObject({ code: 'SOLE_OWNER', soleOwnerOf: [slug], left: [] })
    expect(polar.calls.revoke).toEqual([])
    expect(await gateOf(user.userId)).toBeUndefined()
    expect(await isDeactivated(user.userId)).toBe(false)
  })

  it('leaves each organization, revoking billing access first, and the others keep theirs', async () => {
    const user = await signUp()
    const polar = fakePolar()
    const { b, orgId } = await twoOwners(user, polar)
    expect(polar.has(orgId, user.userId)).toBe(true)
    expect((await deleteAccount(user, polar)).status).toBe(200)
    expect(polar.has(orgId, user.userId)).toBe(false)
    expect(await count('member', 'user_id', user.userId)).toBe(0)
    expect(await count('member', 'user_id', b.userId)).toBeGreaterThan(0)
  })

  it("another user can't delete this account: only the session's user is touched", async () => {
    const user = await signUp()
    const other = await signUp()
    expect((await deleteAccount(other)).status).toBe(200)
    expect(await isDeactivated(user.userId)).toBe(false)
    expect((await post('/update-user', { name: 'still here' }, user)).status).toBe(200)
  })

  it("a deleted user's tenant URLs and server functions answer as for a stranger", async () => {
    const user = await signUp()
    const { slug } = await twoOwners(user)
    await deleteAccount(user)
    await expectStatus(
      () => createProject(user.headers, { tenant: slug, project: { name: 'x' } }),
      401,
    )
  })

  it('writes `account.deleted` with only a SHA-256 of the id, and only after the commit', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => void lines.push(String(line)))
    try {
      const refused = await signUp()
      await createOrg(refused, 'sole')
      await deleteAccount(refused)
      expect(lines.filter((l) => l.includes('account.deleted'))).toEqual([])

      const user = await signUp()
      await deleteAccount(user)
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.userId))
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      )
      const events = lines.filter((l) => l.includes('account.deleted'))
      expect(events.map((l) => JSON.parse(l))).toEqual([
        { level: 'info', event: 'account.deleted', subject_sha256: hash },
      ])
      expect(events[0]).not.toContain(user.email)
      expect(events[0]).not.toContain(user.userId)
      // Why it's a field: the message path's redaction would remove a long opaque string.
      expect(redact(hash)).toBe('[redacted]')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('coming back', { timeout: 60_000 }, () => {
  it('the same email signs up as a new, empty account', async () => {
    const user = await signUp()
    const { slug } = await twoOwners(user)
    await deleteAccount(user)
    const res = await authPost('/sign-up/email', {
      email: user.email,
      password: PASSWORD,
      name: 'new',
    })
    expect(res.ok).toBe(true)
    const { rows } = await sql('SELECT id FROM "user" WHERE email = $1', [user.email])
    expect(rows.length).toBe(1)
    expect(rows[0]!.id).not.toBe(user.userId)
    expect(await count('member', 'user_id', rows[0]!.id as string)).toBe(0)
    expect(slug).toBeTruthy()
  })

  it('a pending invitation to that email stays valid for the new account', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'inv')
    const user = await signUp()
    const { invitationId } = await inviteMember(owner.headers, {
      tenant: slug,
      email: user.email,
      role: 'member',
    })
    await deleteAccount(user)
    await authPost('/sign-up/email', { email: user.email, password: PASSWORD, name: 'new' })
    expect(await count('invitation', 'id', invitationId)).toBe(1)
    const { rows } = await sql(`SELECT status FROM invitation WHERE id = $1`, [invitationId])
    expect(rows[0]!.status).toBe('pending')
  })
})

describe('a concurrent ownership change', { timeout: 60_000 }, () => {
  /** The caller co-owns two organizations; the revoke of the first one is paused. */
  async function caller() {
    const user = await signUp()
    const polar = fakePolar()
    const first = await twoOwners(user, polar)
    const second = await twoOwners(user, polar)
    return { user, polar, first, second }
  }

  it('the caller becoming a sole owner stops there: earlier leaves stand, and the page is told', async () => {
    const { user, polar, first, second } = await caller()
    const revoke = paused()
    const started = paused()
    let order: string[] = []
    polar.before.revoke = async (orgId) => {
      order.push(orgId)
      if (order.length === 1) {
        started.resume()
        await revoke.promise
      }
    }
    const deletion = deleteAccount(user, polar)
    await started.promise
    // The organization not yet reached loses its other owner.
    const firstReached = order[0]!
    const otherOrg = firstReached === first.orgId ? second : first
    const reached = firstReached === first.orgId ? first : second
    const left = await post(
      '/organization/leave',
      { organizationId: otherOrg.orgId },
      otherOrg.b,
      polar,
    )
    expect(left.status).toBe(200)
    revoke.resume()
    const res = await deletion
    expect(res.status).toBe(409)
    expect(await bodyOf(res)).toMatchObject({
      code: 'NOW_SOLE_OWNER',
      left: [reached.slug],
      stillOwner: otherOrg.slug,
    })
    expect(await isDeactivated(user.userId)).toBe(false)
    expect(await count('member', 'user_id', user.userId)).toBe(1)
    expect((await gateOf(user.userId))!.closed_by).toBeNull()
    expect((await post('/update-user', { name: 'still works' }, user, polar)).status).toBe(200)
    order = []
    polar.before.revoke = undefined
  })

  it("refused by the owner guard at commit, when Better Auth's count missed it: same answer", async () => {
    const user = await signUp()
    const { b, orgId, slug } = await twoOwners(user)
    const conn = await createDb(OWNER_URL)
    const q = clientOf(conn.db)
    try {
      // The other owner's removal holds the organization's lock, uncommitted, so the count sees 2.
      await q.query('BEGIN')
      await q.query('SET CONSTRAINTS ALL IMMEDIATE')
      await q.query('DELETE FROM member WHERE organization_id = $1 AND user_id = $2', [
        orgId,
        b.userId,
      ])
      const deletion = deleteAccount(user)
      await lockWaiter('')
      await q.query('COMMIT')
      const res = await deletion
      expect(res.status).toBe(409)
      expect(await bodyOf(res)).toMatchObject({
        code: 'NOW_SOLE_OWNER',
        stillOwner: slug,
        left: [],
      })
      expect(await count('member', 'user_id', user.userId)).toBeGreaterThan(0)
      expect(await isDeactivated(user.userId)).toBe(false)
    } finally {
      await conn.close()
    }
  })

  it('a billing 503 on a leave answers the same shape, reopens the gate, and a retry finishes', async () => {
    const { user, polar, first, second } = await caller()
    let calls = 0
    polar.before.revoke = async () => {
      if (++calls === 2) throw new Error('polar down')
    }
    const res = await deleteAccount(user, polar)
    expect(res.status).toBe(503)
    const body = await bodyOf(res)
    expect(body.code).toBe('BILLING_UNAVAILABLE')
    expect(body.left!.length).toBe(1)
    expect([first.slug, second.slug]).toContain(body.stillOwner)
    expect((await gateOf(user.userId))!.closed_by).toBeNull()
    polar.before.revoke = undefined
    expect((await deleteAccount(user, polar)).status).toBe(200)
  })
})

describe("Polar access can't land after deletion", { timeout: 60_000 }, () => {
  it("grant first: a promotion's grant in flight refuses the deletion until it lands, then the revoke sees it", async () => {
    const user = await signUp()
    const other = await signUp()
    const slug = await createOrg(other, 'grant')
    const orgId = await orgIdOf(slug)
    await joinAs(other, slug, 'member')
    await inviteAs(other, slug, user, 'admin')
    const polar = fakePolar()
    const create = paused()
    const started = paused()
    polar.before.grant = async () => {
      started.resume()
      await create.promise
    }
    const promotion = post(
      '/organization/update-member-role',
      { memberId: await memberIdOf(orgId, user), role: 'owner', organizationId: orgId },
      other,
      polar,
    )
    await started.promise

    // For as long as it lasts: nothing here expires.
    const refused = await deleteAccount(user, polar)
    expect(refused.status).toBe(409)
    expect(await bodyOf(refused)).toMatchObject({ code: 'BILLING_ACCESS_BUSY', left: [] })
    expect((await deleteAccount(user, polar)).status).toBe(409)
    expect(await count('member', 'user_id', user.userId)).toBe(1)

    create.resume()
    expect((await promotion).status).toBe(200)
    expect(polar.has(orgId, user.userId)).toBe(true)
    polar.before.grant = undefined
    expect((await deleteAccount(user, polar)).status).toBe(200)
    expect(polar.has(orgId, user.userId)).toBe(false)
  })

  it('deletion first: while it holds the gate, no path sends this user to Polar', async () => {
    const user = await signUp()
    const polar = fakePolar()
    const { orgId, slug, b } = await twoOwners(user, polar)
    const later = await twoOwners(user, polar)
    await onPaidPlan(later.slug)
    const revoke = paused()
    const started = paused()
    let reached = ''
    polar.before.revoke = async (id) => {
      reached ||= id
      started.resume()
      await revoke.promise
    }
    polar.calls.grant.length = 0
    const deletion = deleteAccount(user, polar)
    await started.promise
    polar.before.revoke = undefined

    // The organization the deletion hasn't left yet: the caller is still an owner there.
    const open = reached === orgId ? later : { orgId, slug, b }
    const provider: BillingProvider = {
      checkout: vi.fn(async () => 'https://checkout.example/x'),
      portal: vi.fn(async () => 'https://portal.example/x'),
      accountState: async () => ({ subscriptions: [], hasPendingCheckout: false }),
    }
    await withDb((db) => gatedBillingMembers(db, polar.members).grant(open.orgId, user.userId))
    expect(polar.calls.grant).toEqual([])
    if (open.slug === later.slug) {
      await expectStatus(
        () => openBillingPortal(user.headers, { tenant: open.slug }, provider),
        409,
      )
      expect(provider.portal).not.toHaveBeenCalled()
    }
    // Another owner's revoke can't make this user its successor.
    polar.calls.revoke.length = 0
    await withDb((db) => gatedBillingMembers(db, polar.members).revoke(open.orgId, open.b.userId))
    expect(polar.calls.revoke).toEqual([{ userId: open.b.userId, successors: [] }])
    polar.present.delete(`${open.orgId}:${user.userId}`)

    revoke.resume()
    expect((await deletion).status).toBe(200)
    expect(polar.has(reached, user.userId)).toBe(false)
    expect(polar.has(open.orgId, user.userId)).toBe(false)
  })

  it('a checkout while the gate is closed sends nothing, and answers 409', async () => {
    const user = await signUp()
    const { slug } = await twoOwners(user)
    const token = crypto.randomUUID()
    await withDb((db) => closeBillingAccess(db, user.userId, token))
    const provider: BillingProvider = {
      checkout: vi.fn(async () => 'https://checkout.example/x'),
      portal: vi.fn(async () => 'https://portal.example/x'),
      accountState: async () => ({ subscriptions: [], hasPendingCheckout: false }),
    }
    await expectStatus(
      () => startCheckout(user.headers, { tenant: slug, price: 'pro_monthly' }, provider),
      409,
    )
    expect(provider.checkout).not.toHaveBeenCalled()
    await withDb((db) => reopenBillingAccess(db, user.userId, token))
  })

  it('a checkout in flight, which can create the customer with this user as its owner, refuses the deletion', async () => {
    const user = await signUp()
    const { slug } = await twoOwners(user)
    const session = paused<string>()
    const started = paused()
    const provider: BillingProvider = {
      checkout: vi.fn(async () => {
        started.resume()
        return session.promise
      }),
      portal: vi.fn(async () => 'https://portal.example/x'),
      accountState: async () => ({ subscriptions: [], hasPendingCheckout: false }),
    }
    const checkout = startCheckout(user.headers, { tenant: slug, price: 'pro_monthly' }, provider)
    await started.promise
    const refused = await deleteAccount(user)
    expect(await bodyOf(refused)).toMatchObject({ code: 'BILLING_ACCESS_BUSY' })
    session.resume('https://checkout.example/x')
    await checkout
    expect((await gateOf(user.userId))!.writes_in_flight).toBe(0)
  })

  it('a successor paused between its create and its promotion keeps its own deletion refused', async () => {
    const successor = await signUp()
    const polar = fakePolar()
    const { b, orgId } = await twoOwners(successor, polar)
    const promote = paused()
    const started = paused()
    polar.before.revoke = async () => {
      started.resume()
      await promote.promise
    }
    const revoking = withDb((db) => gatedBillingMembers(db, polar.members).revoke(orgId, b.userId))
    await started.promise
    polar.before.revoke = undefined
    const refused = await deleteAccount(successor, polar)
    expect(await bodyOf(refused)).toMatchObject({ code: 'BILLING_ACCESS_BUSY' })
    promote.resume()
    await revoking
    expect(polar.has(orgId, successor.userId)).toBe(true)
    expect((await gateOf(successor.userId))!.writes_in_flight).toBe(0)
  })

  it('stale authorization: a grant arriving after a leave and a reopen fails its fresh read, and sends nothing', async () => {
    const user = await signUp()
    const polar = fakePolar()
    const { orgId, b } = await twoOwners(user, polar)
    polar.present.delete(`${orgId}:${user.userId}`)
    polar.calls.grant.length = 0
    const token = crypto.randomUUID()
    await withDb((db) => closeBillingAccess(db, user.userId, token))
    const left = await post('/organization/leave', { organizationId: orgId }, user, polar)
    expect(left.status).toBe(200)
    await withDb((db) => reopenBillingAccess(db, user.userId, token))

    await withDb((db) => gatedBillingMembers(db, polar.members).grant(orgId, user.userId))
    expect(polar.calls.grant).toEqual([])
    expect((await gateOf(user.userId))!.writes_in_flight).toBe(0)
    expect(b.userId).toBeTruthy()

    expect((await deleteAccount(user, polar)).status).toBe(200)
    expect(polar.has(orgId, user.userId)).toBe(false)
  })

  it("overlapping attempts: a second deletion gets 409 and can't reopen behind the first", async () => {
    const user = await signUp()
    const polar = fakePolar()
    const { orgId } = await twoOwners(user, polar)
    const revoke = paused()
    const started = paused()
    polar.before.revoke = async () => {
      started.resume()
      await revoke.promise
    }
    const first = deleteAccount(user, polar)
    await started.promise
    const closedBy = (await gateOf(user.userId))!.closed_by
    const second = await deleteAccount(user, polar)
    expect(await bodyOf(second)).toMatchObject({ code: 'BILLING_ACCESS_BUSY' })
    expect((await gateOf(user.userId))!.closed_by).toBe(closedBy)
    await withDb((db) => gatedBillingMembers(db, polar.members).grant(orgId, user.userId))
    expect(polar.calls.grant.filter((id) => id === user.userId).length).toBe(1)
    revoke.resume()
    expect((await first).status).toBe(200)
    expect(polar.has(orgId, user.userId)).toBe(false)
  })

  it("an attempt whose gate was reopened by an operator can't finish", async () => {
    const user = await signUp()
    await withDb((db) => closeBillingAccess(db, user.userId, 'attempt'))
    await asOwner((q) =>
      q.query('UPDATE billing_access_gate SET closed_by = NULL WHERE user_id = $1', [user.userId]),
    )
    await expect(withDb((db) => deactivateAccount(db, user.userId, 'attempt'))).resolves.toBe(
      'gate-not-held',
    )
    expect(await isDeactivated(user.userId)).toBe(false)
  })

  it('an invitation accepted after the leaves is refused at the finish, and a retry leaves it too', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'late')
    const user = await joinAs(owner, slug, 'member')
    await withDb((db) => closeBillingAccess(db, user.userId, 'attempt'))
    await expect(withDb((db) => deactivateAccount(db, user.userId, 'attempt'))).resolves.toBe(
      'member-remains',
    )
    expect(await isDeactivated(user.userId)).toBe(false)
    await withDb((db) => reopenBillingAccess(db, user.userId, 'attempt'))
    expect((await deleteAccount(user)).status).toBe(200)
  })

  it('deactivation is terminal: nothing changes the gate after it, and a late write sends nothing', async () => {
    const user = await signUp()
    const { orgId } = await twoOwners(user)
    expect((await deleteAccount(user)).status).toBe(200)
    const before = await gateOf(user.userId)
    const late = vi.fn(async () => {})
    const written = await withDb((db) =>
      gatedMemberWrite(db, orgId, user.userId, late, () => false),
    )
    expect(written).toEqual({ sent: false })
    expect(late).not.toHaveBeenCalled()
    expect(await withDb((db) => closeBillingAccess(db, user.userId, 'later'))).toBe(false)
    await withDb((db) => reopenBillingAccess(db, user.userId, before!.closed_by as string))
    expect(await gateOf(user.userId)).toEqual(before)
    expect((await deleteAccount(user)).status).toBe(401)
  })

  it("an unknown outcome stays counted and blocks the deletion; Polar's refusal comes down", async () => {
    const user = await signUp()
    const { orgId } = await twoOwners(user)
    const attempt = (e: Error) =>
      withDb((db) =>
        gatedMemberWrite(
          db,
          orgId,
          user.userId,
          () => Promise.reject(e),
          (x) => x instanceof MemberWriteUnknown,
        ),
      )
    await expect(attempt(new Error('refused'))).rejects.toThrow('refused')
    expect((await gateOf(user.userId))!.writes_in_flight).toBe(0)
    await expect(attempt(new MemberWriteUnknown('lost'))).rejects.toThrow('lost')
    expect((await gateOf(user.userId))!.writes_in_flight).toBe(1)
    const refused = await deleteAccount(user)
    expect(await bodyOf(refused)).toMatchObject({ code: 'BILLING_ACCESS_BUSY' })
    expect(await count('member', 'user_id', user.userId)).toBeGreaterThan(0)
  })

  it("Polar's adapter counts a 5xx or a network error as unknown, and its own refusal as known", async () => {
    const fail = (e: unknown) => memberWrite(() => Promise.reject(e))
    await expect(fail({ statusCode: 503 })).rejects.toBeInstanceOf(MemberWriteUnknown)
    await expect(fail(new TypeError('network'))).rejects.toBeInstanceOf(MemberWriteUnknown)
    const refusal = { statusCode: 422 }
    await expect(fail(refusal)).rejects.toBe(refusal)
  })

  it('a crash leaves the gate closed: checkout and deletion answer 409 until the runbook reopens it', async () => {
    const user = await signUp()
    const { slug } = await twoOwners(user)
    await withDb((db) => closeBillingAccess(db, user.userId, 'crashed'))
    await withDb((db) => reopenBillingAccess(db, user.userId, 'another'))
    expect((await gateOf(user.userId))!.closed_by).toBe('crashed')
    const provider: BillingProvider = {
      checkout: vi.fn(async () => 'https://checkout.example/x'),
      portal: vi.fn(async () => 'https://portal.example/x'),
      accountState: async () => ({ subscriptions: [], hasPendingCheckout: false }),
    }
    await expectStatus(
      () => startCheckout(user.headers, { tenant: slug, price: 'pro_monthly' }, provider),
      409,
    )
    const refused = await deleteAccount(user)
    expect(await bodyOf(refused)).toMatchObject({ code: 'BILLING_ACCESS_BUSY' })
    // Runbook "Stuck account deletion".
    await asOwner((q) =>
      q.query('UPDATE billing_access_gate SET closed_by = NULL WHERE user_id = $1', [user.userId]),
    )
    expect((await deleteAccount(user)).status).toBe(200)
  })
})

describe(
  'a request authenticated before the deactivation, writing after it',
  { timeout: 60_000 },
  () => {
    /**
     * Holds the user's row, as the finishing transaction does, until `action`'s write is waiting on
     * it, then deactivates and commits. `replay_account_deletion` makes the same changes.
     */
    async function deactivateBehind<T>(
      userId: string,
      waitingOn: string,
      action: () => Promise<T>,
    ) {
      const conn = await createDb(OWNER_URL)
      const q = clientOf(conn.db)
      try {
        await q.query('BEGIN')
        await q.query('SELECT 1 FROM "user" WHERE id = $1 FOR UPDATE', [userId])
        const settled = action().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        await lockWaiter(waitingOn)
        await q.query('SELECT replay_account_deletion($1, now())', [userId])
        await q.query('COMMIT')
        return await settled
      } finally {
        await conn.close()
      }
    }
    const refusedStatus = async (r: { value?: Response; error?: unknown }) => {
      expect(r.error).toBeUndefined()
      return (r.value as Response).status
    }

    it('sign-in: no session', async () => {
      const user = await signUp()
      const before = await count('session', 'user_id', user.userId)
      expect(before).toBe(1)
      const r = await deactivateBehind(user.userId, 'insert into "session"', () =>
        post('/sign-in/email', { email: user.email, password: PASSWORD }, null),
      )
      expect(await refusedStatus(r)).toBeGreaterThanOrEqual(400)
      expect(await count('session', 'user_id', user.userId)).toBe(0)
    })

    it('updating the name: refused, and the row stays as it was', async () => {
      const user = await signUp()
      const r = await deactivateBehind(user.userId, 'update "user"', () =>
        post('/update-user', { name: 'written after' }, user),
      )
      expect(await refusedStatus(r)).toBeGreaterThanOrEqual(400)
      const { rows } = await sql('SELECT name FROM "user" WHERE id = $1', [user.userId])
      expect(rows[0]!.name).not.toBe('written after')
    })

    it('changing the password: refused, and no hash comes back', async () => {
      const user = await signUp()
      const r = await deactivateBehind(user.userId, 'update "account"', () =>
        post('/change-password', { currentPassword: PASSWORD, newPassword: `n-${PASSWORD}` }, user),
      )
      expect(await refusedStatus(r)).toBeGreaterThanOrEqual(400)
      const { rows } = await sql('SELECT password FROM account WHERE user_id = $1', [user.userId])
      expect(rows[0]!.password).toBeNull()
    })

    it('requesting a password reset: no row, and no email', async () => {
      const user = await signUp()
      await deactivateBehind(user.userId, 'insert into "verification"', () =>
        post('/request-password-reset', { email: user.email }, null),
      )
      expect(await count('verification', 'value', user.userId)).toBe(0)
      expect(emails.filter((e) => e.kind === 'password-reset')).toEqual([])
    })

    it('a reset link from before: no password comes back', async () => {
      const user = await signUp()
      let url = ''
      const auth = (db: Db) =>
        createAuth({
          db,
          secret: env.BETTER_AUTH_SECRET,
          baseURL: env.BETTER_AUTH_URL,
          allowSignUp: () => true,
          requireEmailVerification: true,
          botProtection: testBotProtection,
          sendEmail: async (email) => {
            if (email.kind === 'password-reset') url = email.url
          },
        })
      await withDb((db) =>
        auth(db).api.requestPasswordReset({ body: { email: user.email }, headers: new Headers() }),
      )
      await vi.waitFor(() => expect(url).not.toBe(''))
      const token = new URL(url).searchParams.get('token')!
      const r = await deactivateBehind(user.userId, 'update "account"', () =>
        post('/reset-password', { token, newPassword: `n-${PASSWORD}` }, null),
      )
      expect(await refusedStatus(r)).toBeGreaterThanOrEqual(400)
      const { rows } = await sql('SELECT password FROM account WHERE user_id = $1', [user.userId])
      expect(rows[0]!.password).toBeNull()
    })

    it('accepting an invitation: no member, and the server function answers 401', async () => {
      const owner = await signUp()
      const slug = await createOrg(owner, 'acc')
      const user = await signUp()
      const { invitationId } = await inviteMember(owner.headers, {
        tenant: slug,
        email: user.email,
        role: 'member',
      })
      const r = await deactivateBehind(user.userId, 'insert into "member"', () =>
        acceptInvitation(user.headers, { invitationId }),
      )
      expect((r as { error: { status: number } }).error.status).toBe(401)
      expect(await count('member', 'user_id', user.userId)).toBe(0)
    })

    it('inviting: no invitation under their name, and 401', async () => {
      const owner = await signUp()
      const slug = await createOrg(owner, 'invt')
      const user = await joinAs(owner, slug, 'admin')
      const r = await deactivateBehind(user.userId, 'insert into "invitation"', () =>
        inviteMember(user.headers, {
          tenant: slug,
          email: `x-${crypto.randomUUID()}@test.local`,
          role: 'member',
        }),
      )
      expect((r as { error: { status: number } }).error.status).toBe(401)
      expect(await count('invitation', 'inviter_id', user.userId)).toBe(0)
    })

    it('creating an organization: no member; the empty organization holds none of their data', async () => {
      const user = await signUp()
      const slug = `orph-${crypto.randomUUID().slice(0, 8)}`
      await deactivateBehind(user.userId, 'insert into "member"', () =>
        createOrganization(user.headers, { name: slug, slug }),
      )
      expect(await count('member', 'user_id', user.userId)).toBe(0)
      // The runbook's ownerless query finds what's left of it.
      const { rows } = await sql(
        `SELECT o.id FROM organization o LEFT JOIN member m ON m.organization_id = o.id
        WHERE o.slug = $1 GROUP BY o.id
       HAVING count(*) FILTER (WHERE m.role ~ '(^|,)\\s*owner\\s*(,|$)') = 0`,
        [slug],
      )
      expect(rows.length).toBe(1)
    })

    it('creating a project: no project under their name, and 401', async () => {
      const owner = await signUp()
      const slug = await createOrg(owner, 'proj')
      const user = await joinAs(owner, slug, 'admin')
      const r = await deactivateBehind(user.userId, 'insert into "project"', () =>
        createProject(user.headers, { tenant: slug, project: { name: 'after' } }),
      )
      expect((r as { error: { status: number } }).error.status).toBe(401)
      expect(await count('project', 'created_by', user.userId)).toBe(0)
    })

    it('a session that committed first is seen and removed by the deactivation', async () => {
      const user = await signUp()
      await post('/sign-in/email', { email: user.email, password: PASSWORD }, null)
      expect(await count('session', 'user_id', user.userId)).toBe(2)
      await deleteAccount(user)
      expect(await count('session', 'user_id', user.userId)).toBe(0)
    })

    it('a deadlock against an in-flight write aborts the deactivation whole: 409, and a retry finishes', async () => {
      const user = await signUp()
      const conn = await createDb(OWNER_URL)
      const q = clientOf(conn.db)
      try {
        // An in-flight password change: it holds the account row, then waits for the user's lock.
        await q.query('BEGIN')
        await q.query(`SET LOCAL deadlock_timeout = '60s'`)
        await q.query('SELECT 1 FROM account WHERE user_id = $1 FOR UPDATE', [user.userId])
        const deletion = deleteAccount(user)
        await lockWaiter('update "account"')
        const write = q
          .query('SELECT 1 FROM "user" WHERE id = $1 FOR KEY SHARE', [user.userId])
          .catch((e: unknown) => e)
        const res = await deletion
        expect(res.status).toBe(409)
        expect(await bodyOf(res)).toMatchObject({ code: 'TRY_AGAIN' })
        expect(await isDeactivated(user.userId)).toBe(false)
        await write
        await q.query('ROLLBACK')
        expect((await gateOf(user.userId))!.closed_by).toBeNull()
        expect((await deleteAccount(user)).status).toBe(200)
      } finally {
        await conn.close()
      }
    })

    it('an invitation a deleted user sent can still be accepted, or cancelled', async () => {
      const owner = await signUp()
      const slug = await createOrg(owner, 'sent')
      await onPaidPlan(slug)
      const inviter = await joinAs(owner, slug, 'admin')
      const invitee = await signUp()
      const { invitationId } = await inviteMember(inviter.headers, {
        tenant: slug,
        email: invitee.email,
        role: 'member',
      })
      const other = await inviteMember(inviter.headers, {
        tenant: slug,
        email: `c-${crypto.randomUUID()}@test.local`,
        role: 'member',
      })
      expect((await deleteAccount(inviter)).status).toBe(200)
      await acceptInvitation(invitee.headers, { invitationId })
      expect(await count('member', 'user_id', invitee.userId)).toBe(1)
      await revokeInvitation(owner.headers, { tenant: slug, invitationId: other.invitationId })
    })
  },
)

describe('the guard covers every link to a user', () => {
  it('every foreign key to `user` has `refuse_deleted_user`, and a new one without it is found', async () => {
    const unguarded = (extra = '') =>
      asOwner(async (q) => {
        await q.query('BEGIN')
        try {
          if (extra) await q.query(extra)
          const { rows } = await q.query(`
            SELECT c.conrelid::regclass::text AS tbl
              FROM pg_constraint c
             WHERE c.contype = 'f' AND c.confrelid = 'public."user"'::regclass
               AND c.conrelid <> 'public.billing_access_gate'::regclass
               AND NOT EXISTS (
                 SELECT FROM pg_trigger t
                  WHERE t.tgrelid = c.conrelid AND t.tgname = 'refuse_deleted_user')
             ORDER BY 1`)
          return rows.map((r) => r.tbl)
        } finally {
          await q.query('ROLLBACK')
        }
      })
    expect(await unguarded()).toEqual([])
    expect(
      await unguarded('CREATE TABLE test_link (user_id text REFERENCES public."user"(id))'),
    ).toEqual(['test_link'])
  })

  it('`verification`, which has no foreign key, has its own', async () => {
    const user = await signUp()
    await deleteAccount(user)
    await expect(
      sql(
        `INSERT INTO verification (id, identifier, value, expires_at)
         VALUES ($1, 'reset-password:x', $2, now() + interval '1 hour')`,
        [crypto.randomUUID(), user.userId],
      ),
    ).rejects.toThrow()
    await sql(
      `INSERT INTO verification (id, identifier, value, expires_at)
       VALUES ($1, 'other-flow', 'not a user id', now() + interval '1 hour')`,
      [crypto.randomUUID()],
    )
  })

  it("app_runtime can't change or remove the ledger, purge or replay", async () => {
    const user = await signUp()
    await deleteAccount(user)
    for (const statement of [
      `UPDATE user_deletion SET purged_at = now() WHERE user_id = '${user.userId}'`,
      `DELETE FROM user_deletion WHERE user_id = '${user.userId}'`,
      `SELECT purge_deleted_account('${user.userId}')`,
      `SELECT replay_account_deletion('${user.userId}', now())`,
      `DELETE FROM billing_access_gate WHERE user_id = '${user.userId}'`,
    ])
      await expect(sql(statement)).rejects.toThrow(/permission denied/)
  })
})

describe('the purge (runbook)', { timeout: 60_000 }, () => {
  const archived = (userId: string, email: string) =>
    asOwner(async (q) => {
      const { rows } = await q.query(
        `SELECT
           (SELECT count(*)::int FROM archive.deleted_row a
             WHERE a.row_data ->> 'user_id' = $1 OR a.row_data ->> 'id' = $1
                OR a.row_data ->> 'email' = $2 OR a.row_data ->> 'inviter_id' = $1
                OR a.row_data ->> 'created_by' = $1) AS rows,
           (SELECT count(*)::int FROM archive.auth_event e
             WHERE e.user_id = $1 OR e.previous_user_id = $1
                OR e.detail ->> 'email' = $2 OR e.detail ->> 'previous_email' = $2) AS events`,
        [userId, email],
      )
      return rows[0]
    })

  it('removes the user and every archived copy, including its own, and keeps the ledger and their projects', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'purge')
    const user = await joinAs(owner, slug, 'admin')
    const project = await createProject(user.headers, { tenant: slug, project: { name: 'stays' } })
    await inviteMember(user.headers, {
      tenant: slug,
      email: `pending-${crypto.randomUUID()}@test.local`,
      role: 'member',
    })
    expect((await deleteAccount(user)).status).toBe(200)
    await asOwner((q) => q.query('SELECT purge_deleted_account($1)', [user.userId]))

    expect(await count('user', 'id', user.userId)).toBe(0)
    expect(await count('account', 'user_id', user.userId)).toBe(0)
    expect(await count('billing_access_gate', 'user_id', user.userId)).toBe(0)
    const { rows } = await sql('SELECT created_by FROM project WHERE id = $1', [project.id])
    expect(rows[0]!.created_by).toBeNull()
    expect(await archived(user.userId, user.email)).toEqual({ rows: 0, events: 0 })
    const ledger = await sql('SELECT * FROM user_deletion WHERE user_id = $1', [user.userId])
    expect(ledger.rows[0]!.purged_at).not.toBeNull()
  })

  it('refuses an account that was never deactivated, and one already purged', async () => {
    const user = await signUp()
    await expect(
      asOwner((q) => q.query('SELECT purge_deleted_account($1)', [user.userId])),
    ).rejects.toThrow(/no deactivated account/)
    await deleteAccount(user)
    await asOwner((q) => q.query('SELECT purge_deleted_account($1)', [user.userId]))
    await expect(
      asOwner((q) => q.query('SELECT purge_deleted_account($1)', [user.userId])),
    ).rejects.toThrow(/no deactivated account/)
  })
})

describe('a restore', { timeout: 60_000 }, () => {
  /** A deactivation the restored database never saw: the ledger row and its effects are gone. */
  const restoredWithout = (userId: string, email: string) =>
    asOwner(async (q) => {
      await q.query('ALTER TABLE public."user" DISABLE TRIGGER refuse_deleted_user')
      try {
        await q.query('DELETE FROM user_deletion WHERE user_id = $1', [userId])
        await q.query('DELETE FROM billing_access_gate WHERE user_id = $1', [userId])
        await q.query('UPDATE public."user" SET email = $2 WHERE id = $1', [userId, email])
      } finally {
        await q.query('ALTER TABLE public."user" ENABLE TRIGGER refuse_deleted_user')
      }
    })

  it("the ledger refuses selective recovery of a deleted user's rows", async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'sel')
    const user = await joinAs(owner, slug, 'admin')
    const orgId = await orgIdOf(slug)
    await deleteAccount(user)
    await expect(
      asOwner((q) =>
        q.query(
          `INSERT INTO member (id, organization_id, user_id, role, created_at)
           VALUES ($1, $2, $3, 'admin', now())`,
          [crypto.randomUUID(), orgId, user.userId],
        ),
      ),
    ).rejects.toThrow(/account is deactivated/)
  })

  it('replay reapplies a missed deactivation, keeps its time, and removes a restored membership', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'rep')
    const user = await joinAs(owner, slug, 'admin')
    const when = new Date('2026-01-02T03:04:05Z')
    await asOwner((q) => q.query('SELECT replay_account_deletion($1, $2)', [user.userId, when]))
    expect(await count('member', 'user_id', user.userId)).toBe(0)
    const { rows } = await sql('SELECT * FROM user_deletion WHERE user_id = $1', [user.userId])
    expect(new Date(rows[0]!.deleted_at as string).toISOString()).toBe(when.toISOString())
    const signIn = await post('/sign-in/email', { email: user.email, password: PASSWORD }, null)
    expect(signIn.status).toBe(401)
    // Twice is harmless: the ledger already has it.
    await asOwner((q) => q.query('SELECT replay_account_deletion($1, $2)', [user.userId, when]))
  })

  it('replay stops at a restored in-flight count or a restored close, until resolved', async () => {
    const user = await signUp()
    await withDb((db) => closeBillingAccess(db, user.userId, 'old attempt'))
    await expect(
      asOwner((q) => q.query('SELECT replay_account_deletion($1, now())', [user.userId])),
    ).rejects.toThrow(/gate is held/)
    await asOwner((q) =>
      q.query(
        `UPDATE billing_access_gate SET closed_by = NULL, writes_in_flight = 1 WHERE user_id = $1`,
        [user.userId],
      ),
    )
    await expect(
      asOwner((q) => q.query('SELECT replay_account_deletion($1, now())', [user.userId])),
    ).rejects.toThrow(/gate is held/)
    expect(await count('user_deletion', 'user_id', user.userId)).toBe(0)
  })

  it('replay stops at a sole owner: the guard refuses, and nothing commits', async () => {
    const user = await signUp()
    await createOrg(user, 'solo')
    await expect(
      asOwner((q) => q.query('SELECT replay_account_deletion($1, now())', [user.userId])),
    ).rejects.toThrow(/no owner/)
    expect(await count('user_deletion', 'user_id', user.userId)).toBe(0)
    expect(await count('session', 'user_id', user.userId)).toBe(1)
  })

  it('replays a deactivation the restored database lost', async () => {
    const user = await signUp()
    expect((await deleteAccount(user)).status).toBe(200)
    await restoredWithout(user.userId, user.email)
    expect(await isDeactivated(user.userId)).toBe(false)
    await asOwner((q) => q.query('SELECT replay_account_deletion($1, now())', [user.userId]))
    expect(await isDeactivated(user.userId)).toBe(true)
    const { rows } = await sql('SELECT email FROM "user" WHERE id = $1', [user.userId])
    expect(rows[0]!.email).toBe(`${user.userId}@deleted.invalid`)
  })
})
