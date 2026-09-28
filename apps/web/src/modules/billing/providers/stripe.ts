// The only place that knows Stripe (ADR-0009, AGENTS.md invariant 6). Turns a signed webhook
// delivery into our provider-neutral BillingEvent; nothing Stripe-shaped leaves this file.
import type { BillingEvent, SubscriptionStatus } from '@saas-foundation/db'
import Stripe from 'stripe'
import { z } from 'zod'

export const PROVIDER = 'stripe'

/** Metadata key our checkout sets on the subscription to link it to an organization. */
export const ORGANIZATION_METADATA_KEY = 'organization_id'

export class InvalidSignature extends Error {
  name = 'InvalidSignature'
}
export class InvalidPayload extends Error {
  name = 'InvalidPayload'
}

const STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'unpaid',
  paused: 'paused',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  canceled: 'canceled',
}

const id = z.string().min(1).max(255)
// Only the fields we store. The period end lives on subscription items in current API versions.
const subscriptionSchema = z.object({
  id,
  object: z.literal('subscription'),
  customer: z.union([id, z.object({ id })]),
  status: z.string(),
  cancel_at_period_end: z.boolean(),
  metadata: z.record(z.string(), z.string()).nullish(),
  items: z.object({
    data: z.array(
      z.object({
        current_period_end: z.number().int().nullish(),
        price: z.object({ id }).nullish(),
      }),
    ),
  }),
})
const eventSchema = z.object({
  id,
  type: z.string().min(1).max(255),
  created: z.number().int(),
  data: z.object({ object: z.object({ object: z.string() }).loose() }),
})

/**
 * Verifies the signature on the raw body BEFORE parsing anything (AGENTS.md invariant 11), then
 * maps the event. Throws InvalidSignature or InvalidPayload.
 */
export async function parseStripeWebhook(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<BillingEvent> {
  let verified: unknown
  try {
    verified = await Stripe.webhooks.constructEventAsync(rawBody, signature ?? '', secret)
  } catch {
    throw new InvalidSignature('signature verification failed')
  }
  const event = eventSchema.safeParse(verified)
  if (!event.success) throw new InvalidPayload('unexpected event shape')
  const { id: eventId, type, created, data } = event.data
  const base = { provider: PROVIDER, eventId, type, createdAt: new Date(created * 1000) }
  if (!type.startsWith('customer.subscription.')) return { ...base, subscription: null }

  const sub = subscriptionSchema.safeParse(data.object)
  if (!sub.success) throw new InvalidPayload('unexpected subscription shape')
  const s = sub.data
  const periodEnds = s.items.data.map((i) => i.current_period_end).filter((n) => n != null)
  return {
    ...base,
    subscription: {
      organizationId: s.metadata?.[ORGANIZATION_METADATA_KEY] || null,
      providerCustomerId: typeof s.customer === 'string' ? s.customer : s.customer.id,
      providerSubscriptionId: s.id,
      providerPriceId: s.items.data[0]?.price?.id ?? null,
      // Unknown future statuses grant nothing (entitlements only follow active/trialing).
      status: STATUS[s.status] ?? 'incomplete',
      currentPeriodEnd: periodEnds.length ? new Date(Math.max(...periodEnds) * 1000) : null,
      cancelAtPeriodEnd: s.cancel_at_period_end,
    },
  }
}
