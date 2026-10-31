// What the billing service needs from a payment provider (ADR-0009, ADR-0022). providers/<name>.ts
// implements it; tests pass a fake. Nothing provider-shaped crosses this seam: each adapter owns its
// customer identity, tax handling and webhook signature scheme.
import type { BillingEvent, SubscriptionSnapshot, SubscriptionStatus } from '@saas-foundation/db'

export type CheckoutRequest = {
  organizationId: string
  /** Billed name on the provider side (an organization-level customer bills the organization). */
  organizationName: string
  /** The organization's existing provider customer, reused so it keeps one billing identity. */
  customerId: string | null
  /** The member starting the checkout (`billing:manage`). */
  userId: string
  customerEmail: string
  /** The buyer's IP (Cloudflare's `cf-connecting-ip`), so the provider prefills their country. */
  customerIp: string | null
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
  customerEmail: string
  returnUrl: string
}

/** A user holding `billing:manage` in an organization (today: an owner). */
export type BillingManager = { userId: string; email: string }

/**
 * Keeps the provider's per-organization billing access in step with `billing:manage` (ADR-0022),
 * for providers where people log in to the billing account themselves. Each call is idempotent and
 * does nothing for an organization without a provider account.
 */
export type BillingMembers = {
  /**
   * Removes the user's access. `successors` are the organization's remaining billing managers,
   * one of whom takes over if the provider needs an account owner. Throws if access can't be
   * removed, so the caller refuses the change (fail closed).
   */
  revoke(organizationId: string, userId: string, successors: BillingManager[]): Promise<void>
  grant(organizationId: string, manager: BillingManager): Promise<void>
  /** Removes the organization's billing account and everyone's access (organization deletion). */
  removeAccount(organizationId: string): Promise<void>
}

/** The provider's own view of an organization's account, ahead of any webhook (ADR-0043). */
export type BillingAccountState = {
  subscriptions: { status: SubscriptionStatus }[]
  /** A checkout session could still complete, or has just completed. */
  hasPendingCheckout: boolean
}

export type BillingProvider = {
  /** Returns the hosted checkout URL. */
  checkout(req: CheckoutRequest): Promise<string>
  /** Returns the hosted billing-portal URL (plan changes, payment methods, invoices, cancel). */
  portal(req: PortalRequest): Promise<string>
  /** Throws if it can't be read: the caller refuses rather than assume there's nothing. */
  accountState(organizationId: string): Promise<BillingAccountState>
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
/**
 * The provider couldn't be reached or isn't configured; the caller should retry (503). `delivery`
 * names a verified webhook delivery, so an already-applied one can be acknowledged instead.
 */
export class ProviderUnavailable extends Error {
  name = 'ProviderUnavailable'
  constructor(
    message: string,
    readonly delivery?: { provider: string; eventId: string },
  ) {
    super(message)
  }
}

/** A verified event; the plan isn't known here (the product policy maps `priceKey` to it). */
export type ProviderEvent = Omit<BillingEvent, 'subscription'> & {
  subscription: (Omit<SubscriptionSnapshot, 'planKey'> & { priceKey: string | null }) | null
}

/**
 * Verifies a delivery's signature on the raw body BEFORE parsing anything (AGENTS.md invariant 11),
 * then maps it. Throws InvalidSignature, InvalidPayload or ProviderUnavailable (nothing recorded,
 * so the provider retries).
 */
export type WebhookParser = (
  rawBody: string,
  headers: Headers,
  secret: string,
) => Promise<ProviderEvent>
