// What the billing service needs from a payment provider (ADR-0009). providers/<name>.ts
// implements it; tests pass a fake.

export type CheckoutRequest = {
  organizationId: string
  /** The organization's existing provider customer, reused so it keeps one billing identity. */
  customerId: string | null
  customerEmail: string
  priceKey: string
  trialDays: number
  automaticTax: boolean
  successUrl: string
  cancelUrl: string
}

export type PortalRequest = { customerId: string; returnUrl: string }

export type BillingProvider = {
  /** Returns the hosted checkout URL. */
  checkout(req: CheckoutRequest): Promise<string>
  /** Returns the hosted billing-portal URL (plan changes, payment methods, invoices, cancel). */
  portal(req: PortalRequest): Promise<string>
}
