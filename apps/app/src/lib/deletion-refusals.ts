/**
 * The organization-deletion path's refusals, each of which establishes that nothing was deleted:
 * the service's checks (modules/organizations/service.ts, server/permissions.ts), the billing hooks
 * (packages/auth) and ADR-0043's gate (server/auth.ts). Only the message reaches the page (the
 * server-function response drops the error's name and status), so the settings page recognises them
 * by text. The server tests assert each one exactly, so rewording a refusal there fails until this
 * list follows.
 */
export const DELETION_REFUSALS = {
  invalidInput: 'invalid input',
  mismatch: "That doesn't match the organization's name",
  forbidden: 'forbidden',
  liveSubscription: 'This organization has an active subscription. Cancel it in Billing first.',
  checkoutInFlight:
    "A checkout for this organization hasn't finished, or its outcome is unknown. Try again shortly; if this persists, contact support.",
  checkoutOpen:
    'A checkout for this organization is still open. Try again once it completes or expires.',
  concurrentChange: 'This organization changed while it was being deleted. Try again shortly.',
  billingUnavailable: "Billing access couldn't be updated. Try again in a moment.",
} as const
