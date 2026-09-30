import { afterEach, beforeEach, vi } from 'vitest'
import { polarWebhookParser } from '../src/modules/billing/providers/polar'
import { handleBillingWebhook } from '../src/modules/billing/webhook'

// Polar webhook deliveries for tests (ADR-0022): signed like Polar signs them, delivered through
// the Polar-mode parser, with Polar's subscription re-read answered by a fetch stub.

export const SECRET = 'polar_whs_test_only_not_a_real_secret'
export const now = () => Math.floor(Date.now() / 1000)
export const deliveryId = () => `msg_${crypto.randomUUID()}`

// Standard Webhooks: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)); Polar's SDK accepts
// the dashboard secret as the raw key.
export async function signed(body: string, id: string, secret = SECRET, t = now()) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${t}.${body}`)),
  )
  return {
    'webhook-id': id,
    'webhook-timestamp': String(t),
    'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
  }
}

type SubOpts = {
  type?: string
  subId?: string
  orgId?: string | null
  customerExternalId?: string | null
  status?: string
  priceKey?: string
  /** The event's time in epoch seconds; defaults to now. */
  created?: number
}
// The shape observed in the sandbox (eval run r2-0929), reduced to what the adapter reads.
export function subscriptionEvent(o: SubOpts = {}) {
  return {
    type: o.type ?? 'subscription.updated',
    timestamp: new Date((o.created ?? now()) * 1000).toISOString(),
    api_version: '2026-04',
    data: {
      id: o.subId ?? crypto.randomUUID(),
      status: o.status ?? 'active',
      customer_id: 'polar-customer-test',
      customer: {
        external_id: o.customerExternalId === undefined ? o.orgId : o.customerExternalId,
      },
      product_id: 'polar-product-test',
      product: { metadata: { price_key: o.priceKey ?? 'pro_monthly' } },
      metadata: o.orgId === null ? {} : { organization_id: o.orgId },
      current_period_end: '2030-01-01T00:00:00Z',
      cancel_at_period_end: false,
    },
  }
}

const config = { accessToken: 'polar_oat_test_only', server: 'sandbox' as const }
/** Polar as the fetch stub answers it: current subscriptions by id, or down (500). */
export const polar = { state: new Map<string, unknown>(), down: false }

/** Installs the stub for GET /v1/subscriptions/{id} around every test of the calling file. */
export function stubPolarApi() {
  beforeEach(() => {
    polar.down = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      const subId = new URL(url).pathname.match(/^\/v1\/subscriptions\/([^/]+)$/)?.[1]
      if (polar.down || !subId || !polar.state.has(subId))
        return new Response('{"detail":"unavailable"}', {
          status: polar.down ? 500 : 404,
          headers: { 'content-type': 'application/json' },
        })
      return Response.json(polar.state.get(subId))
    })
  })
  afterEach(() => vi.unstubAllGlobals())
}

/**
 * Delivers through the Polar-mode parser. `payload` is serialized unless it's already a string.
 * Polar's current state for the subscription is the payload's own unless `current` says otherwise.
 */
export async function deliver(
  payload: unknown,
  opts: { secret?: string; id?: string; headers?: Record<string, string>; current?: unknown } = {},
) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const data = (payload as { data?: { id?: unknown } } | null)?.data
  if (typeof data?.id === 'string') polar.state.set(data.id, opts.current ?? data)
  const headers = opts.headers ?? (await signed(body, opts.id ?? deliveryId()))
  const res = await handleBillingWebhook(
    new Request('http://localhost/api/billing/webhooks/polar', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    }),
    'secret' in opts ? opts.secret : SECRET,
    polarWebhookParser(config),
  )
  const json = res.headers.get('content-type')?.includes('json')
    ? ((await res.json()) as { outcome: string })
    : null
  return { status: res.status, outcome: json?.outcome }
}
