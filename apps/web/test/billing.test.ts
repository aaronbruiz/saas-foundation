import { billing, findOrganizationBySlug } from '@saas-foundation/db'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { getEntitlements } from '../src/modules/billing/entitlements'
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
import { acceptInvitation, inviteMember } from '../src/modules/organizations/service'
import { createProject, listProjects } from '../src/modules/projects/service'
import { handleStripeWebhook } from '../src/modules/billing/webhook'
import { authFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import {
  authPost,
  createOrg,
  expectStatus,
  joinAs,
  randomIp,
  signUp,
  type TestUser,
} from './helpers'

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
  /** The price's lookup key; defaults to a price the policy sells. */
  priceKey?: string | null
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
          data: [
            {
              current_period_end: 1_900_000_000,
              price: {
                id: 'price_test',
                lookup_key: o.priceKey === undefined ? 'pro_monthly' : o.priceKey,
              },
            },
          ],
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
      planKey: 'pro',
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
    expect(await getEntitlements(orgId)).toMatchObject({ planKey: 'pro' })
    // Cross-tenant: the other organization stays on the default plan.
    expect(await getEntitlements(other)).toMatchObject({ planKey: 'free' })
  })

  it('records a price the product does not sell, granting only the default plan', async () => {
    const { orgId } = await freshOrg()
    expect((await deliver(subscriptionEvent({ orgId, priceKey: 'legacy_gold' }))).outcome).toBe(
      'applied',
    )
    expect(await subscriptionOf(orgId)).toMatchObject({ planKey: null, status: 'active' })
    expect(await getEntitlements(orgId)).toMatchObject({ planKey: 'free' })
  })

  it('keeps a paid plan through past_due and drops it when unpaid', async () => {
    const { orgId } = await freshOrg()
    const subId = `sub_${crypto.randomUUID()}`
    const t = now() - 100
    await deliver(subscriptionEvent({ orgId, subId, created: t, status: 'past_due' }))
    expect((await getEntitlements(orgId)).planKey).toBe('pro')
    await deliver(subscriptionEvent({ orgId, subId, created: t + 1, status: 'unpaid' }))
    expect((await getEntitlements(orgId)).planKey).toBe('free')
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

  it('starts the first checkout with the trial, the organization link and tax', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'bill-co')
    const { provider, calls } = fakeProvider()
    const { url } = await startCheckout(owner.headers, { tenant: slug, price }, provider)
    expect(url).toBe('https://checkout.example/session')
    expect(calls.checkout[0]).toMatchObject({
      organizationId: await orgIdOf(slug),
      customerId: null,
      customerEmail: owner.email,
      priceKey: price,
      trialDays: CHECKOUT.trialDays,
      automaticTax: CHECKOUT.automaticTax,
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
    expect(calls.portal[0]).toMatchObject({ customerId: 'cus_test' })

    await deliver(subscriptionEvent({ orgId, subId, status: 'canceled' }))
    await startCheckout(owner.headers, { tenant: slug, price }, provider)
    expect(calls.checkout[0]).toMatchObject({ customerId: 'cus_test', trialDays: 0 })
  })
})
