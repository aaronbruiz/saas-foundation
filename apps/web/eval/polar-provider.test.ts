// ADR-0022 POC: the real Polar adapter (providers/polar.ts) against the Polar sandbox. Not part of
// `pnpm test`; run with `vitest run --config vitest.eval.config.ts` and POLAR_EVAL_RUN=<slug>.
// Uses the sandbox token and eval emails from apps/web/.dev.vars; cleans up its customer.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  NoSuccessor,
  polarClient,
  polarMembers,
  polarProvider,
  polarWebhookParser,
} from '../src/modules/billing/providers/polar'

const vars = env as unknown as Record<string, string | undefined>
const run = vars.POLAR_EVAL_RUN ?? ''
const required = (key: string) => {
  const v = vars[key]
  if (!v) throw new Error(`${key} missing in apps/web/.dev.vars`)
  return v
}

describe.runIf(run !== '' && !vars.POLAR_EVAL_PAID)('polar adapter against the sandbox', () => {
  it('checkout, portal and member sync on one organization customer', async () => {
    if (!/^[a-z0-9-]{4,40}$/.test(run)) throw new Error('POLAR_EVAL_RUN must be a short slug')
    const config = {
      accessToken: required('POLAR_SANDBOX_ACCESS_TOKEN'),
      server: 'sandbox' as const,
    }
    const polar = polarClient(config)
    const provider = polarProvider(config)
    const members = polarMembers(config)
    const orgId = `eval-${run}-org`
    const owner = { userId: `eval-${run}-owner`, email: required('POLAR_EVAL_OWNER_EMAIL') }
    const next = { userId: `eval-${run}-next`, email: required('POLAR_EVAL_NEW_OWNER_EMAIL') }
    const checkoutReq = {
      organizationId: orgId,
      organizationName: `Eval ${run}`,
      customerId: null,
      userId: owner.userId,
      customerEmail: owner.email,
      priceKey: 'pro_monthly',
      trialDays: 14,
      successUrl: 'http://localhost:3000/t/eval/billing?checkout=success',
      cancelUrl: 'http://localhost:3000/t/eval/billing',
    }
    const memberList = async (customerId: string) =>
      (await polar.customers.members.list(customerId, { limit: 100 })).items.map((m) => ({
        ext: m.external_id,
        role: m.role,
      }))

    try {
      // Checkout creates the team customer once (named after the organization), owner = caller.
      const [url1, url2] = await Promise.all([
        provider.checkout(checkoutReq),
        provider.checkout(checkoutReq),
      ])
      expect(url1).toMatch(/^https:\/\/sandbox\.polar\.sh\/checkout\//)
      expect(url2).toMatch(/^https:\/\/sandbox\.polar\.sh\/checkout\//)
      const customer = await polar.customers.getExternal(orgId)
      expect(customer).toMatchObject({ type: 'team', name: `Eval ${run}` })
      expect(await memberList(customer.id)).toEqual([{ ext: owner.userId, role: 'owner' }])
      console.log('[eval] checkout ok; customer', customer.id)

      // Unknown price key → PriceNotFound (the service answers 503).
      await expect(provider.checkout({ ...checkoutReq, priceKey: 'nope' })).rejects.toThrow(
        /price_key nope/,
      )

      // Grant, then revoke the Polar owner: the successor is promoted first, then the owner goes.
      await members.grant(orgId, next)
      await members.grant(orgId, next) // idempotent
      expect(await memberList(customer.id)).toEqual(
        expect.arrayContaining([
          { ext: owner.userId, role: 'owner' },
          { ext: next.userId, role: 'billing_manager' },
        ]),
      )
      await members.revoke(orgId, owner.userId, [next])
      await members.revoke(orgId, owner.userId, [next]) // idempotent
      expect(await memberList(customer.id)).toEqual([{ ext: next.userId, role: 'owner' }])
      console.log('[eval] revoke with successor ok')

      // The last owner can't be revoked (Polar refuses; we refuse first).
      await expect(members.revoke(orgId, next.userId, [])).rejects.toBeInstanceOf(NoSuccessor)

      // More members than one page (Polar lists 10 by default): revoke and grant still find them.
      const extra = Array.from({ length: 12 }, (_, i) => ({
        userId: `eval-${run}-m${i}`,
        email: `eval-${run}-m${i}@mailinator.com`,
      }))
      for (const m of extra) {
        await members.grant(orgId, m)
        await new Promise((r) => setTimeout(r, 1500)) // sandbox rate limit
      }
      const last = extra.at(-1)!
      await members.grant(orgId, last) // already a member on a later page: no duplicate
      expect((await memberList(customer.id)).filter((m) => m.ext === last.userId)).toHaveLength(1)
      await members.revoke(orgId, last.userId, [next])
      expect((await memberList(customer.id)).some((m) => m.ext === last.userId)).toBe(false)
      console.log('[eval] pagination ok (13 members)')

      // Portal: the caller gets a session (and is re-added if a grant was missed).
      const portalUrl = await provider.portal({
        organizationId: orgId,
        customerId: customer.id,
        userId: owner.userId,
        customerEmail: owner.email,
        returnUrl: 'http://localhost:3000/t/eval/billing',
      })
      expect(portalUrl).toMatch(/^https:\/\/sandbox\.polar\.sh\//)
      expect(await memberList(customer.id)).toEqual(
        expect.arrayContaining([{ ext: owner.userId, role: 'billing_manager' }]),
      )
      console.log('[eval] portal ok (missing member repaired)')

      // Organization deletion: the customer goes; a second call is a no-op.
      await members.removeAccount(orgId)
      await members.removeAccount(orgId)
      await expect(polar.customers.getExternal(orgId)).rejects.toThrow()
      console.log('[eval] removeAccount ok')
    } finally {
      await members.removeAccount(orgId).catch(() => {})
    }
  }, 300_000)
})

// Paid flow, by hand: POLAR_EVAL_PAID=start opens a trial checkout through the adapter (and a webhook
// endpoint whose delivery log records the events), you pay with the sandbox test card, then
// POLAR_EVAL_PAID=verify checks in two stages: the trial's events (linked, mapped, re-read as trialing),
// then a revocation-only end on its own events (re-read as canceled). It logs the stored billing
// country. Not covered here (need time or the portal by hand): plan changes, failed renewals.
const paid = vars.POLAR_EVAL_PAID
describe.runIf(run !== '' && (paid === 'start' || paid === 'verify'))('paid checkout', () => {
  it(`paid ${paid}`, async () => {
    const config = {
      accessToken: required('POLAR_SANDBOX_ACCESS_TOKEN'),
      server: 'sandbox' as const,
    }
    const polar = polarClient(config)
    const orgId = `eval-${run}-paid`
    const endpointUrl = `https://example.com/polar-eval/${run}`
    const endpoints = await polar.webhooks.listWebhookEndpoints({ limit: 100 })
    let endpoint = endpoints.items.find((e) => e.url === endpointUrl)

    if (paid === 'start') {
      endpoint ??= await polar.webhooks.createWebhookEndpoint({
        url: endpointUrl,
        format: 'raw',
        events: [
          'subscription.created',
          'subscription.updated',
          'subscription.active',
          'subscription.canceled',
          'subscription.revoked',
          'subscription.past_due',
          'subscription.uncanceled',
        ],
      })
      const url = await polarProvider(config).checkout({
        organizationId: orgId,
        organizationName: `Eval ${run} paid`,
        customerId: null,
        userId: `eval-${run}-owner`,
        customerEmail: required('POLAR_EVAL_OWNER_EMAIL'),
        priceKey: 'pro_monthly',
        trialDays: 14,
        successUrl: 'http://localhost:3000/t/eval/billing?checkout=success',
        cancelUrl: 'http://localhost:3000/t/eval/billing',
      })
      console.log(`[eval] pay with the sandbox test card:\n${url}`)
      return
    }

    if (!endpoint) throw new Error('run POLAR_EVAL_PAID=start first')
    const endpointId = endpoint.id
    const customer = await polar.customers.getExternal(orgId)
    // Billing country as Polar stored it from the checkout (ADR-0022: must be the buyer's real one).
    console.log('[eval] customer billing country:', customer.billing_address?.country ?? null)
    const subs = (await polar.subscriptions.list({ customer_id: customer.id, limit: 10 })).items
    expect(subs).toHaveLength(1)
    expect(subs[0].status).toBe('trialing')
    const parse = polarWebhookParser(config)

    /** The endpoint's subscription events so far, each run through the real parser. */
    async function check(skip: Set<string>, expectedStatus: string) {
      const deliveries = (
        await polar.webhooks.listWebhookDeliveries({ endpoint_id: endpointId, limit: 100 })
      ).items
      const events = new Map(deliveries.map((d) => [d.webhook_event.id, d.webhook_event]))
      const seen: string[] = []
      for (const ev of events.values()) {
        if (skip.has(ev.id)) continue
        skip.add(ev.id)
        const body = JSON.parse(ev.payload ?? '{}')
        if (!String(body.type).startsWith('subscription.')) continue
        expect(body.data.customer.external_id).toBe(orgId)
        expect(body.data.metadata.organization_id).toBe(orgId)
        // The real parser on a freshly signed copy (the endpoint's own secret isn't readable back).
        const secret = 'eval-local-secret'
        const id = `msg_${ev.id}`
        const t = Math.floor(Date.now() / 1000)
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        )
        const mac = new Uint8Array(
          await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(`${id}.${t}.${ev.payload}`),
          ),
        )
        const headers = new Headers({
          'webhook-id': id,
          'webhook-timestamp': String(t),
          'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
        })
        const mapped = await parse(ev.payload!, headers, secret)
        expect(mapped.subscription?.organizationId).toBe(orgId)
        expect(mapped.subscription?.priceKey).toBe('pro_monthly')
        // The re-read state at this stage, whatever the event said when it was sent.
        expect(mapped.subscription?.status).toBe(expectedStatus)
        seen.push(`${body.type}:${body.data.status}`)
      }
      return seen.sort()
    }

    // Stage 1, before anything ends it: the trial's events, re-read as trialing.
    const handled = new Set<string>()
    const trial = await check(handled, 'trialing')
    console.log('[eval] trial events (type:status at delivery):', trial)
    expect(trial).toContain('subscription.created:trialing')

    // Stage 2: a revocation-only end (no cancel first), checked on the events it produces alone.
    await polar.subscriptions.revoke(subs[0].id)
    await new Promise((r) => setTimeout(r, 30_000))
    const end = await check(handled, 'canceled')
    console.log('[eval] revocation events (type:status at delivery):', end)
    expect(end).toContain('subscription.revoked:canceled')

    await polar.webhooks.deleteWebhookEndpoint(endpointId)
    await polarMembers(config).removeAccount(orgId)
  }, 300_000)
})
