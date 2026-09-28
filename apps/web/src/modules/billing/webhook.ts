import { applyBillingEvent } from '@saas-foundation/db'
import { withDb } from '../../server/db'
import { logError, logWarn } from '../../server/log'
import { InvalidPayload, InvalidSignature, parseStripeWebhook } from './providers/stripe'

// Stripe's payloads are far below this; anything bigger isn't worth an HMAC over.
const MAX_BODY = 512 * 1024

/**
 * Stripe webhook endpoint (ADR-0018). Verified on the raw body, deduplicated by event id, applied
 * in one transaction. Without a configured secret it refuses everything (fail closed): previews
 * and local dev have none.
 */
export async function handleStripeWebhook(
  request: Request,
  secret: string | undefined,
): Promise<Response> {
  const rayId = request.headers.get('cf-ray') ?? undefined
  if (!secret) {
    logWarn('billing.webhook.unconfigured', { rayId })
    return new Response('billing webhooks are not configured', { status: 503 })
  }
  const body = await request.text()
  if (body.length > MAX_BODY) return new Response('payload too large', { status: 413 })

  let event
  try {
    event = await parseStripeWebhook(body, request.headers.get('stripe-signature'), secret)
  } catch (e) {
    if (e instanceof InvalidSignature) {
      logWarn('billing.webhook.bad_signature', { rayId })
      return new Response('invalid signature', { status: 400 })
    }
    if (e instanceof InvalidPayload) {
      logWarn('billing.webhook.invalid_payload', { rayId, reason: e.message })
      return new Response('invalid payload', { status: 400 })
    }
    throw e
  }

  let outcome
  try {
    outcome = await withDb((db) => applyBillingEvent(db, event))
  } catch (e) {
    // Nothing was committed; the provider retries the delivery.
    logError('billing.webhook.failed', e, { rayId, eventType: event.type })
    return new Response('temporarily unavailable', { status: 500 })
  }
  if (outcome === 'unlinked') logWarn('billing.webhook.unlinked', { rayId, eventType: event.type })
  return Response.json({ received: true, outcome })
}
