import { applyBillingEvent, isBillingEventRecorded, type BillingEvent } from '@saas-foundation/db'
import { withDb } from '../../server/db'
import { logError, logWarn } from '../../server/log'
import { planForPrice } from './policy'
import { polarWebhook } from './config'
import {
  InvalidPayload,
  InvalidSignature,
  ProviderUnavailable,
  type ProviderEvent,
  type WebhookParser,
} from './provider'
import { parseStripeWebhook } from './providers/stripe'

// Bytes. Provider payloads are far below this; anything bigger isn't worth buffering or an HMAC.
const MAX_BODY = 512 * 1024

/** Stripe webhook endpoint (ADR-0018). Worker secret STRIPE_WEBHOOK_SECRET. */
export const handleStripeWebhook = (request: Request, secret: string | undefined) =>
  handleBillingWebhook(request, secret, parseStripeWebhook)

/** Polar webhook endpoint (ADR-0022). Worker secret POLAR_WEBHOOK_SECRET. */
export const handlePolarWebhook = (request: Request, secret: string | undefined) =>
  handleBillingWebhook(request, secret, polarWebhook())

/**
 * A provider's webhook endpoint (ADR-0018). Verified on the raw body by the provider's `parse`,
 * deduplicated by event id, applied in one transaction. Without a configured secret it refuses
 * everything (fail closed): previews and local dev have none.
 */
export async function handleBillingWebhook(
  request: Request,
  secret: string | undefined,
  parse: WebhookParser,
): Promise<Response> {
  const rayId = request.headers.get('cf-ray') ?? undefined
  if (!secret) {
    logWarn('billing.webhook.unconfigured', { rayId })
    return new Response('billing webhooks are not configured', { status: 503 })
  }
  const body = await readBody(request, MAX_BODY)
  if (body === null) return new Response('payload too large', { status: 413 })

  let parsed: ProviderEvent
  try {
    parsed = await parse(body, request.headers, secret)
  } catch (e) {
    if (e instanceof InvalidSignature) {
      logWarn('billing.webhook.bad_signature', { rayId })
      return new Response('invalid signature', { status: 400 })
    }
    if (e instanceof InvalidPayload) {
      logWarn('billing.webhook.invalid_payload', { rayId, reason: e.message })
      return new Response('invalid payload', { status: 400 })
    }
    // Nothing recorded yet: the provider retries the delivery. One already applied is acknowledged,
    // so a provider outage doesn't make it retry deliveries that are done.
    if (e instanceof ProviderUnavailable) {
      const done = e.delivery && (await isRecorded(e.delivery).catch(() => false))
      if (done) return Response.json({ received: true, outcome: 'duplicate' })
      logWarn('billing.webhook.provider_unavailable', { rayId, reason: e.message })
      return new Response('temporarily unavailable', { status: 503 })
    }
    throw e
  }

  const event = withPlan(parsed)
  // A price this product doesn't sell still records the subscription, but grants only the default
  // plan; it usually means the policy's price list and the provider's lookup keys disagree.
  if (event.subscription && event.subscription.planKey === null)
    logWarn('billing.webhook.unknown_price', { rayId, eventType: event.type })

  let outcome
  try {
    outcome = await withDb((db) => applyBillingEvent(db, event))
  } catch (e) {
    // Nothing was committed; the provider retries the delivery.
    logError('billing.webhook.failed', e, { rayId, eventType: event.type })
    return new Response('temporarily unavailable', { status: 500 })
  }
  if (outcome === 'unlinked' || outcome === 'conflict')
    logWarn(`billing.webhook.${outcome}`, { rayId, eventType: event.type })
  return Response.json({ received: true, outcome })
}

const isRecorded = ({ provider, eventId }: { provider: string; eventId: string }) =>
  withDb((db) => isBillingEventRecorded(db, provider, eventId))

/** Maps the provider's price to our plan through the product policy (ADR-0020). */
function withPlan({ subscription, ...rest }: ProviderEvent): BillingEvent {
  if (!subscription) return { ...rest, subscription: null }
  const { priceKey, ...snapshot } = subscription
  return { ...rest, subscription: { ...snapshot, planKey: planForPrice(priceKey) } }
}

/** The raw body as text, or null once it exceeds `max` bytes (checked before buffering it all). */
async function readBody(request: Request, max: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  // Same decoding as request.text(): the signature is checked over exactly this string.
  return new TextDecoder().decode(bytes)
}
