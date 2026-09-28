import { billing, findOrganizationBySlug } from '@saas-foundation/db'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_ENTITLEMENTS,
  entitlementsFor,
  getEntitlements,
} from '../src/modules/billing/entitlements'
import { handleStripeWebhook } from '../src/modules/billing/webhook'
import { withDb } from '../src/server/db'
import { authPost, createOrg, randomIp, signUp, type TestUser } from './helpers'

// ADR-0018: verified, deduplicated, ordered webhooks; org-owned subscription state; entitlements
// with a safe default. Signatures are computed independently of the Stripe SDK (Stripe's scheme:
// HMAC-SHA256 over `${t}.${body}`), so the test also checks the SDK path we rely on.

const SECRET = 'whsec_test_only_not_a_real_secret'
const now = () => Math.floor(Date.now() / 1000)

async function sign(body: string, secret = SECRET, t = now()) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${t},v1=${hex}`
}

type SubOpts = {
  eventId?: string
  type?: string
  created?: number
  subId?: string
  orgId?: string | null
  status?: string
}
function subscriptionEvent(o: SubOpts = {}) {
  return {
    id: o.eventId ?? `evt_${crypto.randomUUID()}`,
    object: 'event',
    type: o.type ?? 'customer.subscription.updated',
    created: o.created ?? now(),
    data: {
      object: {
        id: o.subId ?? `sub_${crypto.randomUUID()}`,
        object: 'subscription',
        customer: 'cus_test',
        status: o.status ?? 'active',
        cancel_at_period_end: false,
        metadata: o.orgId === null ? {} : { organization_id: o.orgId },
        items: {
          object: 'list',
          data: [{ current_period_end: 1_900_000_000, price: { id: 'price_test' } }],
        },
      },
    },
  }
}

async function deliver(payload: unknown, opts: { secret?: string; signature?: string } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const signature = opts.signature ?? (await sign(body))
  const res = await handleStripeWebhook(
    new Request('http://localhost/api/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }),
    'secret' in opts ? opts.secret : SECRET,
  )
  const json = res.headers.get('content-type')?.includes('json')
    ? ((await res.json()) as { outcome: string })
    : null
  return { status: res.status, outcome: json?.outcome }
}

// Direct SQL for assertions and fixtures only (apps/web doesn't depend on drizzle-orm).
type RawQuery = (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }>
const raw = (db: unknown) => (db as { $client: { query: RawQuery } }).$client

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
  ;[orgA, orgB] = (await Promise.all([freshOrg('bill-a'), freshOrg('bill-b')])).map((o) => o.orgId)
})

describe('Stripe webhook: verification', () => {
  it('fails closed without a configured secret', async () => {
    const event = subscriptionEvent({ orgId: orgA })
    expect((await deliver(event, { secret: undefined })).status).toBe(503)
    expect(await eventRecorded(event.id)).toBe(false)
  })

  it('rejects a bad, missing, stale or foreign signature before touching the database', async () => {
    const event = subscriptionEvent({ orgId: orgA })
    const body = JSON.stringify(event)
    for (const signature of [
      '',
      't=1,v1=00',
      await sign(body, 'whsec_someone_else'),
      await sign(body, SECRET, now() - 3600), // outside Stripe's 5-minute tolerance
      await sign(`${body} `), // signed a different body
    ]) {
      expect((await deliver(body, { signature })).status).toBe(400)
    }
    expect(await eventRecorded(event.id)).toBe(false)
    expect(await subscriptionOf(orgA)).toBeNull()
  })

  it('rejects oversized payloads, counted in bytes', async () => {
    expect((await deliver('x'.repeat(600 * 1024))).status).toBe(413)
    // 300 Ki characters, 600 KiB of UTF-8.
    expect((await deliver('é'.repeat(300 * 1024))).status).toBe(413)
  })

  it('rejects a verified event with an unexpected shape, without recording it', async () => {
    const event = subscriptionEvent({ orgId: orgA })
    const broken = { ...event, data: { object: { object: 'subscription', id: 'sub_x' } } }
    expect((await deliver(broken)).status).toBe(400)
    expect(await eventRecorded(event.id)).toBe(false)
  })
})

describe('Stripe webhook: state', () => {
  const subId = `sub_${crypto.randomUUID()}`
  const t0 = now() - 100

  it('stores the subscription on the organization named in its metadata', async () => {
    const r = await deliver(
      subscriptionEvent({ orgId: orgA, subId, created: t0, type: 'customer.subscription.created' }),
    )
    expect(r).toEqual({ status: 200, outcome: 'applied' })
    expect(await subscriptionOf(orgA)).toMatchObject({
      provider: 'stripe',
      providerCustomerId: 'cus_test',
      providerSubscriptionId: subId,
      providerPriceId: 'price_test',
      planKey: null,
      status: 'active',
      currentPeriodEnd: new Date(1_900_000_000 * 1000),
      cancelAtPeriodEnd: false,
    })
    // Cross-tenant: nothing leaks to another organization.
    expect(await subscriptionOf(orgB)).toBeNull()
  })

  it('processes a redelivered event only once', async () => {
    const event = subscriptionEvent({ orgId: orgA, subId, created: t0 + 10, status: 'past_due' })
    expect((await deliver(event)).outcome).toBe('applied')
    // Same event id, different content: a duplicate is acknowledged and changes nothing.
    const replay = { ...event, data: { object: { ...event.data.object, status: 'canceled' } } }
    expect(await deliver(replay)).toEqual({ status: 200, outcome: 'duplicate' })
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
    const noMeta = subscriptionEvent({ orgId: null })
    expect(await deliver(noMeta)).toEqual({ status: 200, outcome: 'unlinked' })
    const unknownOrg = subscriptionEvent({ orgId: `org-${crypto.randomUUID()}` })
    expect(await deliver(unknownOrg)).toEqual({ status: 200, outcome: 'unlinked' })
    expect(await eventRecorded(noMeta.id)).toBe(true)
  })

  it('records other event types without changing state', async () => {
    const e = {
      id: `evt_${crypto.randomUUID()}`,
      type: 'invoice.paid',
      created: now(),
      data: { object: { object: 'invoice' } },
    }
    expect(await deliver(e)).toEqual({ status: 200, outcome: 'ignored' })
    expect(await eventRecorded(e.id)).toBe(true)
  })

  it('never moves a subscription to another organization (acknowledged, not applied)', async () => {
    const held = (await subscriptionOf(orgA))!.providerSubscriptionId
    const moved = subscriptionEvent({ orgId: orgB, subId: held, created: now() + 5 })
    expect(await deliver(moved)).toEqual({ status: 200, outcome: 'conflict' })
    expect(await subscriptionOf(orgB)).toBeNull()
    expect((await subscriptionOf(orgA))?.providerSubscriptionId).toBe(held)
  })
})

describe('Stripe webhook: replacing a subscription', () => {
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
    const results = await Promise.all([deliver(older), deliver(newer), deliver(newer)])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(1)
    expect((await subscriptionOf(orgId))?.providerSubscriptionId).toBe(newer.data.object.id)
  })
})

describe('organization deletion with billing state (ADR-0018)', () => {
  const deleteOrg = (owner: TestUser, organizationId: string) =>
    authPost('/organization/delete', { organizationId }, randomIp(), owner)

  it('is refused with 409 while the organization has billing state', async () => {
    const { owner, orgId } = await freshOrg()
    await deliver(subscriptionEvent({ orgId }))
    expect((await deleteOrg(owner, orgId)).status).toBe(409)
    expect(await subscriptionOf(orgId)).not.toBeNull()
  })

  it('still works for an organization without billing state', async () => {
    const { owner, orgId } = await freshOrg()
    expect((await deleteOrg(owner, orgId)).status).toBe(200)
  })
})

describe('entitlements', () => {
  const catalog = { pro: { planKey: 'pro', features: ['feature-x'] } }

  it('grants a known plan only while active or trialing', () => {
    expect(entitlementsFor({ status: 'active', planKey: 'pro' }, catalog)).toEqual(catalog.pro)
    expect(entitlementsFor({ status: 'trialing', planKey: 'pro' }, catalog)).toEqual(catalog.pro)
    for (const status of ['past_due', 'unpaid', 'paused', 'incomplete', 'canceled'] as const)
      expect(entitlementsFor({ status, planKey: 'pro' }, catalog)).toBe(DEFAULT_ENTITLEMENTS)
  })

  it('falls back to the default for no subscription, no plan or an unknown plan', () => {
    expect(entitlementsFor(null, catalog)).toBe(DEFAULT_ENTITLEMENTS)
    expect(entitlementsFor({ status: 'active', planKey: null }, catalog)).toBe(DEFAULT_ENTITLEMENTS)
    for (const planKey of ['enterprise', '__proto__', 'constructor', 'toString'])
      expect(entitlementsFor({ status: 'active', planKey }, catalog)).toBe(DEFAULT_ENTITLEMENTS)
  })

  it('is the default everywhere while the plan catalog is empty', async () => {
    expect(await getEntitlements(orgA)).toBe(DEFAULT_ENTITLEMENTS)
    expect(await getEntitlements(orgB)).toBe(DEFAULT_ENTITLEMENTS)
  })

  it("reads only the organization's own subscription (cross-tenant)", async () => {
    const subId = `sub_${crypto.randomUUID()}`
    await deliver(subscriptionEvent({ orgId: orgB, subId, status: 'active' }))
    // Plan keys come from the future catalog mapping; set one directly to exercise the read path.
    await withDb((db) =>
      raw(db).query('UPDATE billing_subscription SET plan_key = $1 WHERE organization_id = $2', [
        'pro',
        orgB,
      ]),
    )
    expect(await getEntitlements(orgB, catalog)).toEqual(catalog.pro)
    expect(await getEntitlements(orgA, catalog)).toBe(DEFAULT_ENTITLEMENTS)
  })
})
