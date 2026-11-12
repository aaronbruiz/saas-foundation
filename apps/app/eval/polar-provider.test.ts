// ADR-0022 POC: the real Polar adapter (providers/polar.ts) against the Polar sandbox. Not part of
// `pnpm test`; run with `vitest run --config vitest.eval.config.ts` and POLAR_EVAL_RUN=<slug>.
// Uses the sandbox token and eval emails from apps/app/.dev.vars; cleans up its customer.
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
  if (!v) throw new Error(`${key} missing in apps/app/.dev.vars`)
  return v
}

// The gate's modes below run on their own: choosing both a gate and a paid mode is refused at load,
// before any provider call (the paid modes need webhook and subscription-write scopes).
if (vars.POLAR_EVAL_GATE && vars.POLAR_EVAL_PAID)
  throw new Error('set POLAR_EVAL_GATE or POLAR_EVAL_PAID, not both')
const adapterRun = run !== '' && !vars.POLAR_EVAL_PAID && !vars.POLAR_EVAL_GATE

/**
 * Runs a sandbox test body so a failure reports only its kind, HTTP status and line: an assertion's
 * or provider error's message can carry checkout and portal links (session credentials), emails or
 * response bodies. Assertions inside compare scalars for the same reason.
 */
const scrubbed = (body: () => Promise<void>) => async () => {
  try {
    await body()
  } catch (e) {
    const err = e as { name?: unknown; statusCode?: unknown; status?: unknown; stack?: unknown }
    // Only values that can't carry text: a plain identifier, a number, and numeric coordinates
    // from a stack frame (a frame line can repeat the message, so it's never copied).
    const name =
      typeof err.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error'
    const code = [err.statusCode, err.status].find((v) => Number.isInteger(v))
    const at = String(err.stack ?? '')
      .split('\n')
      .map((l) => /^\s+at .*polar-provider\.test\.ts:(\d+):(\d+)\)?$/.exec(l))
      .find((m) => m)
    // eslint-disable-next-line preserve-caught-error -- a cause would print the details hidden here
    throw new Error(
      `${name}${code ? ` (HTTP ${code})` : ''} at line ${at ? `${at[1]}:${at[2]}` : 'unknown'}; details hidden`,
    )
  }
}
const sandboxOrigin = (url: string) => new URL(url).origin === 'https://sandbox.polar.sh'
describe.runIf(adapterRun)('polar adapter against the sandbox', () => {
  it(
    'checkout, portal and member sync on one organization customer',
    scrubbed(async () => {
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
        customerIp: null,
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
        expect(sandboxOrigin(url1) && new URL(url1).pathname.startsWith('/checkout/')).toBe(true)
        expect(sandboxOrigin(url2) && new URL(url2).pathname.startsWith('/checkout/')).toBe(true)

        // ADR-0043: both open sessions are visible at once, before anyone has paid.
        const pending = await provider.accountState(orgId)
        expect(pending.subscriptions.length).toBe(0)
        expect(pending.hasPendingCheckout).toBe(true)
        const customer = await polar.customers.getExternal(orgId)
        expect(customer.type).toBe('team')
        expect(customer.name === `Eval ${run}`).toBe(true)
        expect(await memberList(customer.id)).toEqual([{ ext: owner.userId, role: 'owner' }])
        console.log('[eval] checkout ok; customer', customer.id)

        // Unknown price key → PriceNotFound (the service answers 503).
        const refused = await provider.checkout({ ...checkoutReq, priceKey: 'nope' }).then(
          () => 'created',
          (e: unknown) =>
            /price_key nope/.test(String((e as Error).message)) ? 'refused' : 'other',
        )
        expect(refused).toBe('refused')

        // Grant, then revoke the Polar owner: the successor is promoted first, then the owner goes.
        await members.grant(orgId, next)
        // ADR-0044: listed by the first read after the create answers, before any other call.
        expect(await memberList(customer.id)).toContainEqual({
          ext: next.userId,
          role: 'billing_manager',
        })
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
        // Plus-addresses of the owner's own mailbox: Polar checks email domains by DNS, and a public
        // inbox would let anyone read what Polar might send them.
        const [local, domain] = owner.email.split('@') as [string, string]
        const extra = Array.from({ length: 12 }, (_, i) => ({
          userId: `eval-${run}-m${i}`,
          email: `${local.split('+')[0]}+eval-${run}-m${i}@${domain}`,
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
        expect(sandboxOrigin(portalUrl)).toBe(true)
        expect(await memberList(customer.id)).toEqual(
          expect.arrayContaining([{ ext: owner.userId, role: 'billing_manager' }]),
        )
        console.log('[eval] portal ok (missing member repaired)')

        // Organization deletion: the customer goes; a second call is a no-op.
        await members.removeAccount(orgId)
        await members.removeAccount(orgId)
        expect(
          await polar.customers.getExternal(orgId).then(
            () => 'found',
            () => 'gone',
          ),
        ).toBe('gone')
        console.log('[eval] removeAccount ok')
      } finally {
        await members.removeAccount(orgId).catch(() => {})
      }
    }),
    300_000,
  )
})

// Paid flow, by hand: POLAR_EVAL_PAID=start opens a trial checkout through the adapter (and a webhook
// endpoint whose delivery log records the events), you pay with the sandbox test card, then
// POLAR_EVAL_PAID=verify checks in two stages: the trial's events (linked, mapped, re-read as trialing),
// then a revocation-only end on its own events (re-read as canceled). It logs the stored billing
// country. For the portal checks (runbook "Before production go-live"), without revoking anything:
// POLAR_EVAL_PAID=portal prints a portal link for the run's owner, POLAR_EVAL_PAID=events prints
// every event so far as the real parser maps it, and the subscription as Polar holds it now.
// POLAR_EVAL_PAID=endtrial moves the trial's end (the first charge) to 3 minutes from now, to see a
// renewal charged to the card on file (a failing test card for the failed-renewal check).
const paid = vars.POLAR_EVAL_PAID ?? ''
const paidModes = ['start', 'verify', 'status', 'portal', 'events', 'endtrial']
describe.runIf(run !== '' && paidModes.includes(paid))('paid checkout', () => {
  it(`paid ${paid}`, async () => {
    const config = {
      accessToken: required('POLAR_SANDBOX_ACCESS_TOKEN'),
      server: 'sandbox' as const,
    }
    const polar = polarClient(config)
    const orgId = `eval-${run}-paid`
    const endpointUrl = `https://example.com/polar-eval/${run}`
    const endpoints = await polar.webhooks.listWebhookEndpoints({ limit: 100 })
    const endpoint = endpoints.items.find((e) => e.url === endpointUrl)

    if (paid === 'start') {
      if (!endpoint)
        await polar.webhooks.createWebhookEndpoint({
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
        // The buyer's public IP, to check the country prefill (optional).
        customerIp: vars.POLAR_EVAL_CUSTOMER_IP || null,
        priceKey: 'pro_monthly',
        trialDays: 14,
        successUrl: 'http://localhost:3000/t/eval/billing?checkout=success',
        cancelUrl: 'http://localhost:3000/t/eval/billing',
      })
      console.log(`[eval] pay with the sandbox test card:\n${url}`)
      return
    }

    if (paid === 'status') {
      // Read-only: what Polar holds for this run's customer.
      const c = await polar.customers.getExternal(orgId)
      const checkouts = (await polar.checkouts.list({ customer_id: c.id, limit: 20 })).items
      const subs = (await polar.subscriptions.list({ customer_id: c.id, limit: 20 })).items
      console.log('[eval] status', {
        endpoint: Boolean(endpoint),
        checkouts: checkouts.map((x) => ({
          id: x.id.slice(0, 8),
          status: x.status,
          expires: x.expires_at,
        })),
        subscriptions: subs.map((x) => ({ status: x.status, org: x.metadata?.organization_id })),
        country: c.billing_address?.country ?? null,
      })
      return
    }
    if (paid === 'endtrial') {
      const c = await polar.customers.getExternal(orgId)
      const subs = (await polar.subscriptions.list({ customer_id: c.id, limit: 10 })).items
      expect(subs).toHaveLength(1)
      expect(subs[0]!.status).toBe('trialing')
      const trialEnd = new Date(Date.now() + 3 * 60_000).toISOString()
      const s = await polar.subscriptions.update(subs[0]!.id, { trial_end: trialEnd })
      console.log('[eval] trial now ends', s.trial_end, 'period end', s.current_period_end)
      return
    }
    if (paid === 'portal') {
      const c = await polar.customers.getExternal(orgId)
      const url = await polarProvider(config).portal({
        organizationId: orgId,
        customerId: c.id,
        userId: `eval-${run}-owner`,
        customerEmail: required('POLAR_EVAL_OWNER_EMAIL'),
        returnUrl: 'http://localhost:3000/t/eval/billing',
      })
      console.log(`[eval] portal:\n${url}`)
      return
    }
    if (!endpoint) throw new Error('run POLAR_EVAL_PAID=start first')
    const endpointId = endpoint.id
    const parse = polarWebhookParser(config)

    /** The endpoint's events, oldest first, each run through the real parser. */
    async function deliveredEvents() {
      // Every page: each delivery attempt (retries included) is its own row.
      const deliveries = []
      for (let page = 1; ; page++) {
        const res = await polar.webhooks.listWebhookDeliveries({
          endpoint_id: endpointId,
          page,
          limit: 100,
        })
        deliveries.push(...res.items)
        if (page >= res.pagination.max_page || res.items.length === 0) break
      }
      const events = [
        ...new Map(deliveries.map((d) => [d.webhook_event.id, d.webhook_event])).values(),
      ]
      events.sort((a, b) => a.created_at.localeCompare(b.created_at))
      const out = []
      for (const ev of events) {
        const body = JSON.parse(ev.payload ?? '{}')
        if (!String(body.type).startsWith('subscription.')) continue
        // Every endpoint gets the whole sandbox's events: keep this run's (by either link; callers
        // assert both agree).
        if (
          body.data.customer?.external_id !== orgId &&
          body.data.metadata?.organization_id !== orgId
        )
          continue
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
        out.push({ ev, body, mapped: await parse(ev.payload!, headers, secret) })
      }
      return out
    }

    if (paid === 'events') {
      const c = await polar.customers.getExternal(orgId)
      for (const { body, mapped } of await deliveredEvents()) {
        expect(body.data.customer.external_id).toBe(orgId)
        expect(body.data.metadata.organization_id).toBe(orgId)
        expect(mapped.subscription?.organizationId).toBe(orgId)
        // As sent, then as the parser re-read it now.
        const m = mapped.subscription!
        console.log(
          `[eval] ${body.timestamp} ${body.type}` +
            ` sent=${body.data.status}/cancel=${body.data.cancel_at_period_end}/${body.data.product?.metadata?.price_key}` +
            ` now=${m.status}/cancel=${m.cancelAtPeriodEnd}/${m.priceKey} end=${m.currentPeriodEnd?.toISOString()}`,
        )
      }
      const subs = (await polar.subscriptions.list({ customer_id: c.id, limit: 10 })).items
      console.log(
        '[eval] subscriptions now',
        subs.map((x) => ({
          status: x.status,
          priceKey: x.product.metadata?.price_key,
          cancelAtPeriodEnd: x.cancel_at_period_end,
          currentPeriodEnd: x.current_period_end,
          endsAt: x.ends_at,
          amount: x.amount,
          interval: x.recurring_interval,
        })),
      )
      return
    }

    const customer = await polar.customers.getExternal(orgId)
    // Billing country as Polar stored it from the checkout (ADR-0022: must be the buyer's real one).
    console.log('[eval] customer billing country:', customer.billing_address?.country ?? null)
    const subs = (await polar.subscriptions.list({ customer_id: customer.id, limit: 10 })).items
    expect(subs).toHaveLength(1)
    expect(subs[0]!.status).toBe('trialing')

    /** The endpoint's subscription events not yet in `skip`, checked against the run. */
    async function check(skip: Set<string>, expectedStatus: string) {
      const seen: string[] = []
      for (const { ev, body, mapped } of await deliveredEvents()) {
        if (skip.has(ev.id)) continue
        skip.add(ev.id)
        expect(body.data.customer.external_id).toBe(orgId)
        expect(body.data.metadata.organization_id).toBe(orgId)
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
    await polar.subscriptions.revoke(subs[0]!.id)
    await new Promise((r) => setTimeout(r, 30_000))
    const end = await check(handled, 'canceled')
    console.log('[eval] revocation events (type:status at delivery):', end)
    expect(end).toContain('subscription.revoked:canceled')

    await polar.webhooks.deleteWebhookEndpoint(endpointId)
    await polarMembers(config).removeAccount(orgId)
  }, 300_000)
})

// ADR-0043 release gate, one scenario per mode, with only the app's own token scopes (no webhook
// endpoint, no subscription writes). POLAR_EVAL_GATE=open opens one session through the adapter and
// checks it's listed as soon as the create answers (a); run it once per scenario (paid, abandoned,
// declined), noting the id it prints. =status prints every session and subscription (read-only),
// for (b) and (c). =paid checks the paid session's subscription carries its `checkout_id` and is
// listed by customer (b). =freeportal creates a customer with no subscription and prints its portal
// link (d). =cleanup deletes both customers (Polar cancels their subscriptions) and reads each
// subscription back to show it ended; sessions can't be deleted and stay as Polar holds them.
// Checkout and portal links carry session credentials (the checkout's client secret, the portal's
// customer session token and the member's email): they're printed only with
// POLAR_EVAL_SHOW_LINKS=1, for the owner's own terminal, never in saved evidence.
const gate = vars.POLAR_EVAL_GATE ?? ''
describe.runIf(run !== '' && ['open', 'status', 'paid', 'freeportal', 'cleanup'].includes(gate))(
  'ADR-0043 gate',
  () => {
    it(
      `gate ${gate}`,
      scrubbed(async () => {
        if (!/^[a-z0-9-]{4,40}$/.test(run)) throw new Error('POLAR_EVAL_RUN must be a short slug')
        const config = {
          accessToken: required('POLAR_SANDBOX_ACCESS_TOKEN'),
          server: 'sandbox' as const,
        }
        const polar = polarClient(config)
        const provider = polarProvider(config)
        const orgId = `eval-${run}-gate`
        const freeId = `eval-${run}-free`
        const owner = { userId: `eval-${run}-owner`, email: required('POLAR_EVAL_OWNER_EMAIL') }
        const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : null)
        const showLink = (label: string, url: string) =>
          console.log(
            vars.POLAR_EVAL_SHOW_LINKS === '1'
              ? `[gate] ${label}:\n${url}`
              : `[gate] ${label}: ${new URL(url).origin}/… (hidden; POLAR_EVAL_SHOW_LINKS=1 shows it)`,
          )
        // As the adapter reads it (providers/polar.ts statusOf).
        const status = (e: unknown) =>
          (e as { statusCode?: number })?.statusCode ?? (e as { status?: number })?.status
        /** The customer, null only on Polar's 404; any other failure propagates (outcome unknown). */
        const customerOrNull = (externalId: string) =>
          polar.customers.getExternal(externalId).catch((e: unknown) => {
            if (status(e) === 404) return null
            throw e
          })
        const sessionsOf = async (customerId: string) =>
          (await polar.checkouts.list({ customer_id: customerId, limit: 100 })).items
        const subscriptionsOf = async (customerId: string) =>
          (await polar.subscriptions.list({ customer_id: customerId, limit: 100 })).items

        if (gate === 'open') {
          // The customer is read (or created, as the adapter would) before the checkout, so the list
          // below is the first provider request after the create answers.
          const customer =
            (await customerOrNull(orgId)) ??
            (await polar.customers.create({
              type: 'team',
              external_id: orgId,
              name: `Eval ${run} gate`,
              metadata: { organization_id: orgId },
              owner: { email: owner.email, external_id: owner.userId },
            }))
          const url = await provider.checkout({
            organizationId: orgId,
            organizationName: `Eval ${run} gate`,
            customerId: customer.id,
            userId: owner.userId,
            customerEmail: owner.email,
            customerIp: null,
            priceKey: 'pro_monthly',
            trialDays: 14,
            successUrl: 'http://localhost:3000/t/eval/billing?checkout=success',
            cancelUrl: 'http://localhost:3000/t/eval/billing',
          })
          // (a) No wait and no other request between the create's answer and this list.
          const session = (await sessionsOf(customer.id)).find((c) => c.url === url)
          expect(session !== undefined, 'session listed as soon as its create answered').toBe(true)
          expect((await provider.accountState(orgId)).hasPendingCheckout).toBe(true)
          console.log('[gate] (a) listed at once', {
            session: short(session!.id),
            status: session!.status,
            expires: session!.expires_at,
          })
          showLink('checkout page', url)
          return
        }

        if (gate === 'status') {
          const customer = await polar.customers.getExternal(orgId)
          console.log('[gate] sessions', {
            at: new Date().toISOString(),
            sessions: (await sessionsOf(customer.id)).map((c) => ({
              id: short(c.id),
              status: c.status,
              expires: c.expires_at,
            })),
            subscriptions: (await subscriptionsOf(customer.id)).map((s) => ({
              id: short(s.id),
              status: s.status,
              checkout: short(s.checkout_id),
            })),
            accountState: await provider.accountState(orgId),
          })
          return
        }

        if (gate === 'paid') {
          const customer = await polar.customers.getExternal(orgId)
          const succeeded = (await sessionsOf(customer.id)).filter((c) => c.status === 'succeeded')
          const subs = await subscriptionsOf(customer.id)
          expect(succeeded.length).toBe(1)
          expect(subs.length).toBe(1)
          // (b) The subscription names its session, and the list by customer found it.
          expect(subs[0]!.checkout_id === succeeded[0]!.id, 'checkout_id is the paid session').toBe(
            true,
          )
          const state = await provider.accountState(orgId)
          expect(state.subscriptions.length).toBe(1)
          console.log('[gate] (b) paid', {
            session: short(succeeded[0]!.id),
            subscription: short(subs[0]!.id),
            status: subs[0]!.status,
            checkout: short(subs[0]!.checkout_id),
            hasPendingCheckout: state.hasPendingCheckout,
          })
          return
        }

        if (gate === 'freeportal') {
          const customer = await polar.customers.create({
            type: 'team',
            external_id: freeId,
            name: `Eval ${run} free`,
            metadata: { organization_id: freeId },
            owner: { email: owner.email, external_id: owner.userId },
          })
          expect((await subscriptionsOf(customer.id)).length).toBe(0)
          const url = await provider.portal({
            organizationId: freeId,
            customerId: customer.id,
            userId: owner.userId,
            customerEmail: owner.email,
            returnUrl: 'http://localhost:3000/t/eval/billing',
          })
          showLink('(d) portal for a customer with no subscription', url)
          return
        }

        // cleanup
        const ended = []
        for (const id of [orgId, freeId]) {
          const customer = await customerOrNull(id)
          if (!customer) {
            console.log('[gate] cleanup: no customer (404)', id)
            continue
          }
          const subs = await subscriptionsOf(customer.id)
          await polarMembers(config).removeAccount(id)
          expect((await customerOrNull(id)) === null, `${id} gone (404) after the delete`).toBe(
            true,
          )
          for (const s of subs) ended.push(await polar.subscriptions.get(s.id))
          console.log('[gate] cleanup: customer deleted', id)
        }
        console.log(
          '[gate] cleanup: subscriptions now',
          ended.map((s) => ({ id: short(s.id), status: s.status, endedAt: s.ended_at })),
        )
      }),
      120_000,
    )
  },
)
