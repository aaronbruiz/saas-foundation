import { applyBillingEvent } from '@saas-foundation/db'
import { withDb } from '../../server/db'
import { logError, logWarn } from '../../server/log'
import { InvalidPayload, InvalidSignature, parseStripeWebhook } from './providers/stripe'

// Bytes. Stripe's payloads are far below this; anything bigger isn't worth buffering or an HMAC.
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
  const body = await readBody(request, MAX_BODY)
  if (body === null) return new Response('payload too large', { status: 413 })

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
  if (outcome === 'unlinked' || outcome === 'conflict')
    logWarn(`billing.webhook.${outcome}`, { rayId, eventType: event.type })
  return Response.json({ received: true, outcome })
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
