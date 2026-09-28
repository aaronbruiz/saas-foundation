// THE product billing policy (ADR-0020): plans, their prices, limits and features, the trial, tax,
// and the lifecycle rules. A different product changes this file (and its own enforcement points,
// which only ask this file). Nothing here knows the provider or does I/O.
// Who may see and manage billing lives with every other role rule, in server/permissions.ts.
import type { SubscriptionStatus } from '@saas-foundation/db'

/** A plan limit; `null` means unlimited. */
export type Limit = number | null

/** What an organization may use. Authorization and limits read only this (AGENTS.md invariant 6). */
export type Entitlements = {
  planKey: PlanKey
  limits: { projects: Limit; members: Limit }
  /** Feature flags a plan unlocks; the reference product has none (plans differ by limits). */
  features: readonly string[]
}

type Plan = {
  name: string
  limits: Entitlements['limits']
  features: readonly string[]
  /**
   * Provider prices that buy this plan, by lookup key (set on the price in the provider's
   * dashboard; amounts and currency live there, not in code). Keep retired keys listed so
   * existing subscribers keep their plan.
   */
  prices: readonly { key: string; interval: 'month' | 'year' }[]
}

export const PLANS = {
  // The default: every organization without an entitled subscription.
  free: { name: 'Free', limits: { projects: 3, members: 3 }, features: [], prices: [] },
  pro: {
    name: 'Pro',
    limits: { projects: null, members: 50 },
    features: [],
    prices: [
      { key: 'pro_monthly', interval: 'month' },
      { key: 'pro_yearly', interval: 'year' },
    ],
  },
} as const satisfies Record<string, Plan>

export type PlanKey = keyof typeof PLANS
export const DEFAULT_PLAN: PlanKey = 'free'

/** Checkout settings (flat price per organization, quantity 1). */
export const CHECKOUT = {
  /** Only for an organization's first subscription; the provider collects a payment method. */
  trialDays: 14,
  /** Provider-calculated tax (Stripe Tax): needs tax registrations set up before going live. */
  automaticTax: true,
} as const

/**
 * Statuses that keep a paid plan's entitlements. `past_due` is included: the provider is still
 * retrying the payment (Stripe Smart Retries), and cutting access on the first failed charge
 * punishes expired cards. `unpaid` (retries exhausted), `paused`, `incomplete` and `canceled` fall
 * back to the default plan.
 */
const ENTITLED: ReadonlySet<SubscriptionStatus> = new Set(['active', 'trialing', 'past_due'])

const entitlementsOf = (key: PlanKey): Entitlements => ({
  planKey: key,
  limits: PLANS[key].limits,
  features: PLANS[key].features,
})

export const isPlanKey = (key: string | null | undefined): key is PlanKey =>
  typeof key === 'string' && Object.hasOwn(PLANS, key)

export function entitlementsFor(
  subscription: { status: SubscriptionStatus; planKey: string | null } | null,
): Entitlements {
  if (subscription && ENTITLED.has(subscription.status) && isPlanKey(subscription.planKey))
    return entitlementsOf(subscription.planKey)
  return entitlementsOf(DEFAULT_PLAN)
}

/** The plan a provider price buys, or null for a price this product doesn't sell. */
export function planForPrice(priceKey: string | null): PlanKey | null {
  if (!priceKey) return null
  for (const [key, plan] of Object.entries(PLANS) as [PlanKey, Plan][])
    if (plan.prices.some((p) => p.key === priceKey)) return key
  return null
}

/** Prices a customer can start a subscription with (retired keys excluded by not listing them here). */
export const purchasablePrices = () =>
  (Object.entries(PLANS) as [PlanKey, Plan][]).flatMap(([plan, p]) =>
    p.prices.map((price) => ({ plan, planName: p.name, ...price })),
  )

/**
 * A subscription that can still charge the customer. While one exists the organization can't be
 * deleted (cancel it in the billing portal first) and can't start another checkout.
 */
export const isLive = (subscription: { status: SubscriptionStatus } | null) =>
  subscription !== null && subscription.status !== 'canceled'

/** The trial applies only to an organization that has never had a subscription. */
export const trialDaysFor = (subscription: unknown | null) =>
  subscription === null ? CHECKOUT.trialDays : 0
