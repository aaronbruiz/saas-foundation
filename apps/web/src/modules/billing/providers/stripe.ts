// The only place that knows Stripe (ADR-0009, AGENTS.md invariant 6). Turns a signed webhook
// delivery into a provider-neutral event, and creates Checkout and billing-portal sessions.
// Nothing Stripe-shaped leaves this file.
import type { BillingEvent, SubscriptionSnapshot, SubscriptionStatus } from '@saas-foundation/db'
import Stripe from 'stripe'
import { z } from 'zod'
import type { BillingProvider, CheckoutRequest, PortalRequest } from '../provider'

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
        price: z.object({ id, lookup_key: z.string().max(255).nullish() }).nullish(),
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

/** A verified event; the plan isn't known here (the product policy maps `priceKey` to it). */
export type ProviderEvent = Omit<BillingEvent, 'subscription'> & {
  subscription: (Omit<SubscriptionSnapshot, 'planKey'> & { priceKey: string | null }) | null
}

/**
 * Verifies the signature on the raw body BEFORE parsing anything (AGENTS.md invariant 11), then
 * maps the event. Throws InvalidSignature or InvalidPayload.
 */
export async function parseStripeWebhook(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<ProviderEvent> {
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
      priceKey: s.items.data[0]?.price?.lookup_key ?? null,
      // Unknown future statuses grant nothing (not an entitled status in the policy).
      status: STATUS[s.status] ?? 'incomplete',
      currentPeriodEnd: periodEnds.length ? new Date(Math.max(...periodEnds) * 1000) : null,
      cancelAtPeriodEnd: s.cancel_at_period_end,
    },
  }
}

export class PriceNotFound extends Error {
  name = 'PriceNotFound'
}

/** Stripe behind the provider interface. `secretKey` is the Worker secret STRIPE_SECRET_KEY. */
export function stripeProvider(secretKey: string): BillingProvider {
  const stripe = new Stripe(secretKey)
  return {
    async checkout(req: CheckoutRequest) {
      // Prices are addressed by lookup key, so the code never embeds provider price ids.
      const { data } = await stripe.prices.list({
        lookup_keys: [req.priceKey],
        active: true,
        limit: 1,
      })
      const price = data[0]
      if (!price) throw new PriceNotFound(`no active price with lookup key ${req.priceKey}`)
      const link = { [ORGANIZATION_METADATA_KEY]: req.organizationId }
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: price.id, quantity: 1 }],
        client_reference_id: req.organizationId,
        metadata: link,
        // The webhook links the subscription to the organization through this metadata.
        subscription_data: {
          metadata: link,
          ...(req.trialDays > 0 && { trial_period_days: req.trialDays }),
        },
        ...(req.customerId
          ? {
              customer: req.customerId,
              ...(req.automaticTax && { customer_update: { address: 'auto' as const } }),
            }
          : { customer_email: req.customerEmail }),
        automatic_tax: { enabled: req.automaticTax },
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
      })
      if (!session.url) throw new Error('checkout session has no url')
      return session.url
    },
    async portal(req: PortalRequest) {
      const session = await stripe.billingPortal.sessions.create({
        customer: req.customerId,
        return_url: req.returnUrl,
      })
      return session.url
    },
  }
}
