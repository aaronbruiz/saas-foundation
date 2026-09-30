// What the billing service needs from a payment provider (ADR-0009, ADR-0022). providers/<name>.ts
// implements it; tests pass a fake. Nothing provider-shaped crosses this seam: each adapter owns its
// customer identity, tax handling and webhook signature scheme.
import type { BillingEvent, SubscriptionSnapshot } from '@saas-foundation/db'

export type CheckoutRequest = {
  organizationId: string
  /** Billed name on the provider side (an organization-level customer bills the organization). */
  organizationName: string
  /** The organization's existing provider customer, reused so it keeps one billing identity. */
  customerId: string | null
  /** The member starting the checkout (`billing:manage`). */
  userId: string
  customerEmail: string
  priceKey: string
  trialDays: number
  successUrl: string
  cancelUrl: string
}

export type PortalRequest = {
  organizationId: string
  customerId: string
  /** The member opening the portal (`billing:manage`). */
  userId: string
  returnUrl: string
}

export type BillingProvider = {
  /** Returns the hosted checkout URL. */
  checkout(req: CheckoutRequest): Promise<string>
  /** Returns the hosted billing-portal URL (plan changes, payment methods, invoices, cancel). */
  portal(req: PortalRequest): Promise<string>
}

export class InvalidSignature extends Error {
  name = 'InvalidSignature'
}
export class InvalidPayload extends Error {
  name = 'InvalidPayload'
}
export class PriceNotFound extends Error {
  name = 'PriceNotFound'
}

/** A verified event; the plan isn't known here (the product policy maps `priceKey` to it). */
export type ProviderEvent = Omit<BillingEvent, 'subscription'> & {
  subscription: (Omit<SubscriptionSnapshot, 'planKey'> & { priceKey: string | null }) | null
}

/**
 * Verifies a delivery's signature on the raw body BEFORE parsing anything (AGENTS.md invariant 11),
 * then maps it. Throws InvalidSignature or InvalidPayload.
 */
export type WebhookParser = (
  rawBody: string,
  headers: Headers,
  secret: string,
) => Promise<ProviderEvent>
