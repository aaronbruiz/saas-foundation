import {
  applyBillingEvent,
  billing,
  createDb,
  findOrganizationBySlug,
  type BillingEvent,
  type Db,
} from '@saas-foundation/db'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  CHECKOUT,
  DEFAULT_PLAN,
  PLANS,
  entitlementsFor,
  isLive,
  planForPrice,
  purchasablePrices,
  trialDaysFor,
} from '../src/modules/billing/policy'
import type {
  BillingProvider,
  CheckoutRequest,
  PortalRequest,
} from '../src/modules/billing/provider'
import {
  getBillingOverview,
  openBillingPortal,
  startCheckout,
} from '../src/modules/billing/service'
import {
  acceptInvitation,
  inviteMember,
  listMembers,
  removeMember,
} from '../src/modules/organizations/service'
import { createProject, listProjects } from '../src/modules/projects/service'
import { authFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { inTenant, rawDb } from '@saas-foundation/db/internal'
import {
  authPost,
  createOrg,
  entitlementsOf,
  expectStatus,
  joinAs,
  randomIp,
  signUp,
  type TestUser,
} from './helpers'
import {
  SECRET,
  deliver,
  deliveryId,
  now,
  signed,
  stubPolarApi,
  subscriptionEvent,
} from './polar-webhook'

// ADR-0018: verified, deduplicated, ordered webhooks; org-owned subscription state; entitlements
// with a safe default. Deliveries are Polar's (ADR-0022), signed independently of Polar's SDK.

stubPolarApi()

// Direct SQL for assertions and fixtures only (apps/app doesn't depend on drizzle-orm).
type RawQuery = (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }>
const raw = (db: Db) => (rawDb(db) as unknown as { $client: { query: RawQuery } }).$client

const subscriptionOf = (orgId: string) => withDb((db) => billing(db, { orgId }).subscription())
const eventRecorded = (eventId: string) =>
  withDb(async (db) => {
    const r = await raw(db).query('SELECT 1 FROM billing_webhook_event WHERE event_id = $1', [
      eventId,
    ])
    return r.rowCount === 1
  })
const orgIdOf = async (slug: string) => (await withDb((db) => findOrganizationBySlug(db, slug)))!.id

let orgA: string
let orgB: string

async function freshOrg(prefix = 'bill'): Promise<{ owner: TestUser; orgId: string }> {
  const owner = await signUp()
  return { owner, orgId: await orgIdOf(await createOrg(owner, prefix)) }
}

beforeAll(async () => {
  const [a, b] = await Promise.all([freshOrg('bill-a'), freshOrg('bill-b')])
  orgA = a.orgId
  orgB = b.orgId
})

describe('billing webhook: verification', () => {
  it('fails closed without a configured secret', async () => {
    const id = deliveryId()
    expect(
      (await deliver(subscriptionEvent({ orgId: orgA }), { id, secret: undefined })).status,
    ).toBe(503)
    expect(await eventRecorded(id)).toBe(false)
  })

  it('rejects a bad, missing, stale or foreign signature before touching the database', async () => {
    const event = subscriptionEvent({ orgId: orgA })
    const body = JSON.stringify(event)
    const id = deliveryId()
    for (const headers of [
      {},
      { 'webhook-id': id, 'webhook-timestamp': String(now()), 'webhook-signature': 'v1,AAAA' },
      await signed(body, id, 'polar_whs_someone_else'),
      await signed(body, id, SECRET, now() - 3600), // outside the Standard Webhooks tolerance
      await signed(`${body} `, id), // signed a different body
    ]) {
      expect((await deliver(body, { headers })).status).toBe(400)
    }
    expect(await eventRecorded(id)).toBe(false)
    expect(await subscriptionOf(orgA)).toBeNull()
  })

  it('rejects oversized payloads, counted in bytes', async () => {
    expect((await deliver('x'.repeat(600 * 1024))).status).toBe(413)
    // 300 Ki characters, 600 KiB of UTF-8.
    expect((await deliver('é'.repeat(300 * 1024))).status).toBe(413)
  })

  it('rejects a verified event with an unexpected shape, without recording it', async () => {
    const event = subscriptionEvent({ orgId: orgA })
    const id = deliveryId()
    const broken = { ...event, data: { id: 'sub_x', status: 'active' } }
    expect((await deliver(broken, { id })).status).toBe(400)
    expect(await eventRecorded(id)).toBe(false)
  })
})

describe('billing webhook: state', () => {
  const subId = `sub_${crypto.randomUUID()}`
  const t0 = now() - 100

  it('stores the subscription on the organization named in its metadata', async () => {
    const r = await deliver(
      subscriptionEvent({ orgId: orgA, subId, created: t0, type: 'subscription.created' }),
    )
    expect(r).toEqual({ status: 200, outcome: 'applied' })
    expect(await subscriptionOf(orgA)).toMatchObject({
      provider: 'polar',
      providerCustomerId: 'polar-customer-test',
      providerSubscriptionId: subId,
      providerPriceId: 'polar-product-test',
      planKey: 'pro',
      status: 'active',
      currentPeriodEnd: new Date('2030-01-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
    })
    // Cross-tenant: nothing leaks to another organization.
    expect(await subscriptionOf(orgB)).toBeNull()
  })

  it('processes a redelivered event only once', async () => {
    const event = subscriptionEvent({ orgId: orgA, subId, created: t0 + 10, status: 'past_due' })
    const id = deliveryId()
    expect((await deliver(event, { id })).outcome).toBe('applied')
    // Same delivery id, different content: a duplicate is acknowledged and changes nothing.
    const replay = { ...event, data: { ...event.data, status: 'canceled' } }
    expect(await deliver(replay, { id })).toEqual({ status: 200, outcome: 'duplicate' })
    expect((await subscriptionOf(orgA))?.status).toBe('past_due')
  })

  it('ignores events older than the stored state', async () => {
    const old = subscriptionEvent({ orgId: orgA, subId, created: t0 + 5, status: 'canceled' })
    expect((await deliver(old)).outcome).toBe('stale')
    expect((await subscriptionOf(orgA))?.status).toBe('past_due')
  })

  it("doesn't let a replaced subscription's cancellation overwrite the current one", async () => {
    const other = subscriptionEvent({ orgId: orgA, created: t0 + 50, status: 'canceled' })
    expect((await deliver(other)).outcome).toBe('stale')
    expect((await subscriptionOf(orgA))?.providerSubscriptionId).toBe(subId)
  })

  it('maps unknown provider statuses to a non-entitled status', async () => {
    const e = subscriptionEvent({ orgId: orgA, subId, created: t0 + 60, status: 'some_future' })
    expect((await deliver(e)).outcome).toBe('applied')
    expect((await subscriptionOf(orgA))?.status).toBe('incomplete')
  })

  it('acknowledges but does not apply events it cannot link to an organization', async () => {
    const id = deliveryId()
    const noMeta = subscriptionEvent({ orgId: null, customerExternalId: null })
    expect(await deliver(noMeta, { id })).toEqual({ status: 200, outcome: 'unlinked' })
    const unknownOrg = subscriptionEvent({ orgId: `org-${crypto.randomUUID()}` })
    expect(await deliver(unknownOrg)).toEqual({ status: 200, outcome: 'unlinked' })
    expect(await eventRecorded(id)).toBe(true)
  })

  it('records other event types without changing state', async () => {
    const id = deliveryId()
    const e = { type: 'order.paid', timestamp: new Date().toISOString(), data: { id: 'order_x' } }
    expect(await deliver(e, { id })).toEqual({ status: 200, outcome: 'ignored' })
    expect(await eventRecorded(id)).toBe(true)
  })

  it('never moves a subscription to another organization (acknowledged, not applied)', async () => {
    const held = (await subscriptionOf(orgA))!.providerSubscriptionId
    const moved = subscriptionEvent({ orgId: orgB, subId: held, created: now() + 5 })
    expect(await deliver(moved)).toEqual({ status: 200, outcome: 'conflict' })
    expect(await subscriptionOf(orgB)).toBeNull()
    expect((await subscriptionOf(orgA))?.providerSubscriptionId).toBe(held)
  })
})

describe('billing webhook: replacing a subscription', () => {
  it('orders per subscription, not per organization', async () => {
    const { orgId } = await freshOrg()
    const [old, next, late] = ['old', 'next', 'late'].map((n) => `sub_${n}_${crypto.randomUUID()}`)
    const t = now() - 1000
    await deliver(subscriptionEvent({ orgId, subId: old, created: t }))
    await deliver(subscriptionEvent({ orgId, subId: old, created: t + 50, status: 'canceled' }))
    // The replacement was created before the old one's cancellation event, and arrives after it.
    expect(
      (await deliver(subscriptionEvent({ orgId, subId: next, created: t + 30 }))).outcome,
    ).toBe('applied')
    // A late event for the canceled subscription doesn't take the organization back.
    const lateCancel = subscriptionEvent({ orgId, subId: old, created: t + 60, status: 'canceled' })
    expect((await deliver(lateCancel)).outcome).toBe('stale')
    // A different live subscription replaces a live one only if newer.
    expect(
      (await deliver(subscriptionEvent({ orgId, subId: late, created: t + 20 }))).outcome,
    ).toBe('stale')
    expect(
      (await deliver(subscriptionEvent({ orgId, subId: late, created: t + 70 }))).outcome,
    ).toBe('applied')
    expect(await subscriptionOf(orgId)).toMatchObject({
      providerSubscriptionId: late,
      status: 'active',
    })
  })

  it('handles concurrent deliveries for one organization without errors', async () => {
    const { orgId } = await freshOrg()
    const t = now() - 1000
    const older = subscriptionEvent({ orgId, created: t })
    const newer = subscriptionEvent({ orgId, created: t + 10 })
    const id = deliveryId()
    const results = await Promise.all([
      deliver(older),
      deliver(newer, { id }),
      deliver(newer, { id }),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(1)
    expect((await subscriptionOf(orgId))?.providerSubscriptionId).toBe(newer.data.id)
  })
})

describe('the subscription holder check (ADR-0040 webhook bypass)', () => {
  type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
  const HELD = 'select public.billing_subscription_held_elsewhere($1, $2) as held'
  // Direct connections (docker-compose's known credentials, as in global-setup.ts); test-only.
  // `options` sets a session-level setting at connection start, which no statement guard sees:
  // what trusted SQL with the runtime credential could do.
  const RUNTIME_URL = 'postgres://app_runtime:app_runtime@localhost:5432/app_test'
  const OWNER_URL = 'postgres://app:app@localhost:5432/app_test'
  const withSessionOrg = (url: string, org: string) =>
    `${url}?options=${encodeURIComponent(`-c app.org_id=${org}`)}`
  const queryOf = (db: Db | object): Q => {
    const c = ('$client' in db ? db : rawDb(db as Db)) as unknown as { $client: { query: Q } }
    return c.$client.query.bind(c.$client) as Q
  }
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e),
    )
  async function on<T>(url: string, fn: (q: Q, db: Db) => Promise<T>) {
    const { db, close } = await createDb(url)
    try {
      return await fn(queryOf(db), db)
    } finally {
      await close()
    }
  }
  /** The check as the webhook runs it: in a tenant transaction for `orgId`. */
  const heldFor = (orgId: string, provider: string, subId: string) =>
    withDb((db) =>
      inTenant(db, { orgId }, async (tx) => (await queryOf(tx)(HELD, [provider, subId])).rows),
    )

  const provider = 'polar'
  const eventFor = (organizationId: string, providerSubscriptionId: string): BillingEvent => ({
    provider,
    eventId: `evt_${crypto.randomUUID()}`,
    type: 'subscription.updated',
    createdAt: new Date(),
    subscription: {
      organizationId,
      providerCustomerId: 'polar-customer-test',
      providerSubscriptionId,
      providerPriceId: null,
      planKey: null,
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    },
  })
  const apply = (e: BillingEvent) => withDb((db) => applyBillingEvent(db, e))

  let holder: string
  let other: string
  let subId: string
  beforeAll(async () => {
    const [a, b] = await Promise.all([freshOrg(), freshOrg()])
    holder = a.orgId
    other = b.orgId
    subId = `sub_held_${crypto.randomUUID()}`
    expect(await apply(eventFor(holder, subId))).toBe('applied')
  })

  it("answers only yes or no for the tenant's own transaction, never who holds it", async () => {
    expect(await heldFor(other, provider, subId)).toEqual([{ held: true }])
    expect(await heldFor(holder, provider, subId)).toEqual([{ held: false }])
    expect(await heldFor(other, provider, `sub_unknown_${crypto.randomUUID()}`)).toEqual([
      { held: false },
    ])
    expect(await heldFor(other, 'another-provider', subId)).toEqual([{ held: false }])
  })

  it('links one subscription applied for two organizations at once to exactly one of them', async () => {
    // Directly on the repository: Polar has one truth per subscription, so the stub can't race this.
    const [c, d] = await Promise.all([freshOrg(), freshOrg()])
    const raced = `sub_race_${crypto.randomUUID()}`
    const events = [c.orgId, d.orgId].map((o) => eventFor(o, raced))
    const first = await Promise.allSettled(events.map(apply))
    // The loser sees the winner (conflict) or hits the unique constraint (an error: nothing is
    // recorded, the provider retries), and its retry then answers conflict.
    const outcomes = await Promise.all(
      first.map((r, i) => (r.status === 'fulfilled' ? r.value : apply(events[i]!))),
    )
    expect(outcomes.sort()).toEqual(['applied', 'conflict'])
    const holders = await Promise.all(
      [c, d].map(async (o) => (await subscriptionOf(o.orgId))?.providerSubscriptionId),
    )
    expect(holders.filter((s) => s === raced)).toHaveLength(1)
  })

  it('fails closed (42501) without a tenant, with an empty, unknown or malformed one, or null input', async () => {
    const refused = {
      noTenant: await on(RUNTIME_URL, (q) => codeOf(q(HELD, [provider, subId]))),
      emptyTenant: await on(withSessionOrg(RUNTIME_URL, ''), (q) =>
        codeOf(q(HELD, [provider, subId])),
      ),
      malformedTenant: await on(withSessionOrg(RUNTIME_URL, "x'OR'1'='1"), (q) =>
        codeOf(q(HELD, [provider, subId])),
      ),
      unknownTenant: await codeOf(heldFor(`org_${crypto.randomUUID()}`, provider, subId)),
      nullProvider: await codeOf(heldFor(other, null as unknown as string, subId)),
      nullSubscription: await codeOf(heldFor(other, provider, null as unknown as string)),
    }
    expect(refused).toEqual(Object.fromEntries(Object.keys(refused).map((k) => [k, '42501'])))
  })

  it('rolls back the whole tenant transaction when it refuses', async () => {
    const eventId = `evt_${crypto.randomUUID()}`
    const failed = withDb((db) =>
      inTenant(db, { orgId: other }, async (tx) => {
        await queryOf(tx)(
          'insert into billing_webhook_event (provider, event_id, type) values ($1, $2, $3)',
          [provider, eventId, 'test'],
        )
        return queryOf(tx)(HELD, [null, subId])
      }),
    )
    expect(await codeOf(failed)).toBe('42501')
    expect(await eventRecorded(eventId)).toBe(false)
  })

  it("can't be redirected by temporary tables, functions or the caller's search_path", async () => {
    const fake = `sub_fake_${crypto.randomUUID()}`
    const answers = await withDb(async (db) => {
      const q = queryOf(db)
      await q(
        'create temp table billing_subscription (provider text, provider_subscription_id text, organization_id text)',
      )
      await q('insert into billing_subscription values ($1, $2, $3)', [provider, fake, holder])
      await q('create temp table organization (id text)')
      await q(
        `create function pg_temp.current_setting(text, boolean) returns text language sql as 'select ''nobody'''`,
      )
      await q('set search_path = pg_temp, public')
      return inTenant(db, { orgId: other }, async (tx) => [
        (await queryOf(tx)(HELD, [provider, fake])).rows,
        (await queryOf(tx)(HELD, [provider, subId])).rows,
      ])
    })
    expect(answers).toEqual([[{ held: false }], [{ held: true }]])
  })

  it("still sees other tenants' holders once row-level security hides their rows from the runtime role", async () => {
    // Phase 3's policy shape, enabled only inside this rolled-back transaction (ADR-0040 decision 5).
    const seen = await on(withSessionOrg(OWNER_URL, other), async (q) => {
      await q('BEGIN')
      try {
        await q('ALTER TABLE public.billing_subscription ENABLE ROW LEVEL SECURITY')
        await q(
          `CREATE POLICY tenant ON public.billing_subscription TO app_runtime
             USING (organization_id = NULLIF(current_setting('app.org_id', true), ''))`,
        )
        await q('SET LOCAL ROLE app_runtime')
        return {
          direct: (
            await q(
              'select organization_id from billing_subscription where provider = $1 and provider_subscription_id = $2',
              [provider, subId],
            )
          ).rows,
          held: (await q(HELD, [provider, subId])).rows,
        }
      } finally {
        await q('ROLLBACK')
      }
    })
    expect(seen).toEqual({ direct: [], held: [{ held: true }] })
  })
})

describe('organization deletion with a live subscription (ADR-0020)', () => {
  const deleteOrg = (owner: TestUser, organizationId: string) =>
    authPost('/organization/delete', { organizationId }, randomIp(), owner)

  const activeOrg = async (user: TestUser) => {
    const res = await withDb((db) =>
      authFor(db).handler(
        new Request(`${env.BETTER_AUTH_URL}/api/auth/get-session`, { headers: user.headers }),
      ),
    )
    return ((await res.json()) as { session: { activeOrganizationId: string | null } }).session
      .activeOrganizationId
  }

  it('is refused with 409 while the organization has billing state, session untouched', async () => {
    const { owner, orgId } = await freshOrg()
    await deliver(subscriptionEvent({ orgId }))
    const setActive = await authPost(
      '/organization/set-active',
      { organizationId: orgId },
      randomIp(),
      owner,
    )
    expect(setActive.status).toBe(200)
    expect(await activeOrg(owner)).toBe(orgId)

    const res = await deleteOrg(owner, orgId)
    expect(res.status).toBe(409)
    expect(await subscriptionOf(orgId)).not.toBeNull()
    expect(await activeOrg(owner)).toBe(orgId)
  })

  it("doesn't reveal billing state to non-members", async () => {
    const { orgId } = await freshOrg()
    await deliver(subscriptionEvent({ orgId }))
    const stranger = await signUp()
    const res = await deleteOrg(stranger, orgId)
    expect(res.status).not.toBe(409)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await subscriptionOf(orgId)).not.toBeNull()
  })

  it('works once the subscription has ended, and removes its record', async () => {
    const { owner, orgId } = await freshOrg()
    const subId = `sub_${crypto.randomUUID()}`
    await deliver(subscriptionEvent({ orgId, subId, created: now() - 10 }))
    await deliver(subscriptionEvent({ orgId, subId, status: 'canceled' }))
    expect((await deleteOrg(owner, orgId)).status).toBe(200)
    expect(await subscriptionOf(orgId)).toBeNull()
  })

  it('still works for an organization without billing state', async () => {
    const { owner, orgId } = await freshOrg()
    expect((await deleteOrg(owner, orgId)).status).toBe(200)
  })
})

describe('entitlements from webhook state (ADR-0020)', () => {
  it('maps the price to the plan through the policy, per organization', async () => {
    const { orgId } = await freshOrg()
    const { orgId: other } = await freshOrg()
    await deliver(subscriptionEvent({ orgId, priceKey: 'pro_yearly' }))
    expect(await entitlementsOf(orgId)).toMatchObject({ planKey: 'pro' })
    // Cross-tenant: the other organization stays on the default plan.
    expect(await entitlementsOf(other)).toMatchObject({ planKey: 'free' })
  })

  it('records a price the product does not sell, granting only the default plan', async () => {
    const { orgId } = await freshOrg()
    expect((await deliver(subscriptionEvent({ orgId, priceKey: 'legacy_gold' }))).outcome).toBe(
      'applied',
    )
    expect(await subscriptionOf(orgId)).toMatchObject({ planKey: null, status: 'active' })
    expect(await entitlementsOf(orgId)).toMatchObject({ planKey: 'free' })
  })

  it('keeps a paid plan through past_due and drops it when unpaid', async () => {
    const { orgId } = await freshOrg()
    const subId = `sub_${crypto.randomUUID()}`
    const t = now() - 100
    await deliver(subscriptionEvent({ orgId, subId, created: t, status: 'past_due' }))
    expect((await entitlementsOf(orgId)).planKey).toBe('pro')
    await deliver(subscriptionEvent({ orgId, subId, created: t + 1, status: 'unpaid' }))
    expect((await entitlementsOf(orgId)).planKey).toBe('free')
  })
})

// ---------------------------------------------------------------------------------------------
// ADR-0020: the product policy is the one place that decides; these tests pin its boundaries.

describe('billing policy (pure)', () => {
  it('gives every organization without an entitled subscription the default plan', () => {
    expect(DEFAULT_PLAN).toBe('free')
    expect(entitlementsFor(null).planKey).toBe(DEFAULT_PLAN)
    for (const planKey of [null, 'enterprise', '__proto__', 'constructor', 'toString'])
      expect(entitlementsFor({ status: 'active', planKey }).planKey).toBe(DEFAULT_PLAN)
  })

  it('keeps a paid plan only while active, trialing or past_due', () => {
    const entitled = ['active', 'trialing', 'past_due'] as const
    const notEntitled = ['unpaid', 'paused', 'incomplete', 'canceled'] as const
    for (const status of entitled)
      expect(entitlementsFor({ status, planKey: 'pro' }).planKey).toBe('pro')
    for (const status of notEntitled)
      expect(entitlementsFor({ status, planKey: 'pro' }).planKey).toBe(DEFAULT_PLAN)
  })

  it('keeps retired prices mapped to their plan but never sells them', () => {
    // Every listed price maps to its plan; purchasable ones are the non-retired subset.
    for (const [key, plan] of Object.entries(PLANS))
      for (const p of plan.prices) expect(planForPrice(p.key)).toBe(key)
    const sold = new Set(purchasablePrices().map((p) => p.key))
    for (const plan of Object.values(PLANS))
      for (const p of plan.prices as readonly { key: string; retired?: boolean }[])
        expect(sold.has(p.key)).toBe(!p.retired)
  })

  it('maps each price to exactly one plan', () => {
    const keys = purchasablePrices().map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const p of purchasablePrices()) expect(planForPrice(p.key)).toBe(p.plan)
    expect(planForPrice('not-a-price')).toBeNull()
    expect(planForPrice(null)).toBeNull()
    // The default plan is never sold.
    expect(purchasablePrices().some((p) => p.plan === DEFAULT_PLAN)).toBe(false)
  })

  it('treats every non-canceled subscription as live, and offers a trial only once', () => {
    expect(isLive(null)).toBe(false)
    for (const status of [
      'active',
      'trialing',
      'past_due',
      'unpaid',
      'paused',
      'incomplete',
    ] as const)
      expect(isLive({ status })).toBe(true)
    expect(isLive({ status: 'canceled' })).toBe(false)
    expect(trialDaysFor(null)).toBe(CHECKOUT.trialDays)
    expect(trialDaysFor({ status: 'canceled' })).toBe(0)
  })

  it('has limits for every plan', () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.limits).toHaveProperty('projects')
      expect(plan.limits).toHaveProperty('members')
    }
  })
})

async function upgrade(orgId: string, status = 'active') {
  const subId = `sub_${crypto.randomUUID()}`
  await deliver(subscriptionEvent({ orgId, subId, status, created: now() - 60 }))
  return subId
}

describe('plan limits are enforced where the resource is created', () => {
  const freeProjects = PLANS[DEFAULT_PLAN].limits.projects!
  const create = (owner: TestUser, slug: string, name: string) =>
    createProject(owner.headers, { tenant: slug, project: { name } })

  it('stops new projects at the limit; upgrading lifts it; downgrading keeps existing ones', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'lim')
    const orgId = await orgIdOf(slug)
    for (let i = 0; i < freeProjects; i++) await create(owner, slug, `p${i}`)
    await expectStatus(() => create(owner, slug, 'over'), 403)

    const subId = await upgrade(orgId)
    await create(owner, slug, 'with-pro')
    await deliver(subscriptionEvent({ orgId, subId, status: 'canceled' }))

    // Back on the default plan: nothing is deleted, but nothing new until under the limit.
    expect(await listProjects(owner.headers, { tenant: slug })).toHaveLength(freeProjects + 1)
    await expectStatus(() => create(owner, slug, 'after-downgrade'), 403)
  })

  it("can't be overshot by concurrent creations", async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'race')
    const results = await Promise.allSettled(
      Array.from({ length: freeProjects + 3 }, (_, i) => create(owner, slug, `r${i}`)),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(freeProjects)
  })

  it('limits seats through Better Auth: invitations beyond free seats are refused', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'seats')
    const seats = PLANS[DEFAULT_PLAN].limits.members!
    for (let i = 1; i < seats; i++) await joinAs(owner, slug, 'member')
    await expect(
      inviteMember(owner.headers, { tenant: slug, email: `x-${crypto.randomUUID()}@test.local` }),
    ).rejects.toThrow()

    await upgrade(await orgIdOf(slug))
    await joinAs(owner, slug, 'member')
  })

  it('removing a member frees a seat for a new invitation', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'free')
    const seats = PLANS[DEFAULT_PLAN].limits.members!
    let last = owner
    for (let i = 1; i < seats; i++) last = await joinAs(owner, slug, 'member')
    const email = `x-${crypto.randomUUID()}@test.local`
    await expect(inviteMember(owner.headers, { tenant: slug, email })).rejects.toThrow()

    const rows = await listMembers(owner.headers, { tenant: slug })
    const memberId = rows.find((r) => r.email === last.email)!.id
    await removeMember(owner.headers, { tenant: slug, memberId })
    await expect(inviteMember(owner.headers, { tenant: slug, email })).resolves.toBeDefined()
  })

  it('refuses accepting an invitation once the seats are gone (e.g. after a downgrade)', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'accept')
    const orgId = await orgIdOf(slug)
    const subId = await upgrade(orgId)
    for (let i = 1; i < PLANS[DEFAULT_PLAN].limits.members!; i++)
      await joinAs(owner, slug, 'member')
    const late = await signUp()
    const { invitationId } = await inviteMember(owner.headers, { tenant: slug, email: late.email })
    await deliver(subscriptionEvent({ orgId, subId, status: 'canceled' }))
    await expectStatus(() => acceptInvitation(late.headers, { invitationId }), 403)
  })
})

describe('billing actions', () => {
  function fakeProvider() {
    const calls: { checkout: CheckoutRequest[]; portal: PortalRequest[] } = {
      checkout: [],
      portal: [],
    }
    const provider: BillingProvider = {
      checkout: async (req) => (calls.checkout.push(req), 'https://checkout.example/session'),
      portal: async (req) => (calls.portal.push(req), 'https://portal.example/session'),
    }
    return { provider, calls }
  }
  const price = purchasablePrices()[0]!.key

  it('lets owners and admins see billing, and only owners buy', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'bill-roles')
    const admin = await joinAs(owner, slug, 'admin')
    const member = await joinAs(owner, slug, 'member')
    const { provider } = fakeProvider()

    expect((await getBillingOverview(owner.headers, { tenant: slug })).canManage).toBe(true)
    const adminView = await getBillingOverview(admin.headers, { tenant: slug })
    expect(adminView).toMatchObject({ canManage: false, plan: { key: DEFAULT_PLAN } })
    await expectStatus(() => getBillingOverview(member.headers, { tenant: slug }), 403)
    await expectStatus(() => startCheckout(admin.headers, { tenant: slug, price }, provider), 403)
    await expectStatus(() => startCheckout(member.headers, { tenant: slug, price }, provider), 403)
  })

  it("never lets another tenant's user start a checkout (404)", async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'bill-x')
    const stranger = await signUp()
    const { provider, calls } = fakeProvider()
    await expectStatus(
      () => startCheckout(stranger.headers, { tenant: slug, price }, provider),
      404,
    )
    expect(calls.checkout).toHaveLength(0)
  })

  it('starts the first checkout with the trial and the organization link', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'bill-co')
    const { provider, calls } = fakeProvider()
    const headers = new Headers(owner.headers)
    headers.set('cf-connecting-ip', '190.12.64.1')
    const { url } = await startCheckout(headers, { tenant: slug, price }, provider)
    expect(url).toBe('https://checkout.example/session')
    expect(calls.checkout[0]).toMatchObject({
      organizationId: await orgIdOf(slug),
      organizationName: slug,
      customerId: null,
      userId: owner.userId,
      customerEmail: owner.email,
      customerIp: '190.12.64.1',
      priceKey: price,
      trialDays: CHECKOUT.trialDays,
      successUrl: `${env.BETTER_AUTH_URL}/t/${slug}/billing?checkout=success`,
      cancelUrl: `${env.BETTER_AUTH_URL}/t/${slug}/billing`,
    })
  })

  it('refuses unknown prices, a second live subscription, and missing configuration', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'bill-no')
    const { provider } = fakeProvider()
    await expectStatus(
      () => startCheckout(owner.headers, { tenant: slug, price: 'free_forever' }, provider),
      400,
    )
    await expectStatus(() => startCheckout(owner.headers, { tenant: slug, price }, null), 503)
    await upgrade(await orgIdOf(slug), 'past_due')
    await expectStatus(() => startCheckout(owner.headers, { tenant: slug, price }, provider), 409)
    expect((await getBillingOverview(owner.headers, { tenant: slug })).prices).toEqual([])
  })

  it('reuses the customer and skips the trial after a subscription ended; portal needs one', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'bill-again')
    const orgId = await orgIdOf(slug)
    const { provider, calls } = fakeProvider()
    await expectStatus(() => openBillingPortal(owner.headers, { tenant: slug }, provider), 409)

    const subId = await upgrade(orgId)
    await openBillingPortal(owner.headers, { tenant: slug }, provider)
    expect(calls.portal[0]).toMatchObject({
      organizationId: orgId,
      customerId: 'polar-customer-test',
      userId: owner.userId,
    })

    await deliver(subscriptionEvent({ orgId, subId, status: 'canceled' }))
    await startCheckout(owner.headers, { tenant: slug, price }, provider)
    expect(calls.checkout[0]).toMatchObject({ customerId: 'polar-customer-test', trialDays: 0 })
  })
})
