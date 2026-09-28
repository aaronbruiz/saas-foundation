import { billing, type BillingSubscription } from '@saas-foundation/db'
import { withDb } from '../../server/db'

/** What an organization may use. Authorization reads only this (AGENTS.md invariant 6). */
export type Entitlements = {
  planKey: string | null
  features: readonly string[]
}

/** Plan key → entitlements. Empty until the owner decides the plan catalog (ADR-0018). */
export type PlanCatalog = Readonly<Record<string, Entitlements>>
export const PLAN_CATALOG: PlanCatalog = {}

/** No subscription, an unknown plan or a non-entitled status: nothing beyond the base product. */
export const DEFAULT_ENTITLEMENTS: Entitlements = Object.freeze({
  planKey: null,
  features: Object.freeze([]),
})

// Which statuses keep a plan's entitlements (e.g. a grace period for past_due) is an open product
// decision; until then only these do.
const ENTITLED: ReadonlySet<BillingSubscription['status']> = new Set(['active', 'trialing'])

export function entitlementsFor(
  subscription: Pick<BillingSubscription, 'status' | 'planKey'> | null,
  catalog: PlanCatalog = PLAN_CATALOG,
): Entitlements {
  if (!subscription?.planKey || !ENTITLED.has(subscription.status)) return DEFAULT_ENTITLEMENTS
  return Object.hasOwn(catalog, subscription.planKey)
    ? catalog[subscription.planKey]!
    : DEFAULT_ENTITLEMENTS
}

/** `orgId` must come from a verified tenant context (`getTenantContext`), never from input. */
export async function getEntitlements(
  orgId: string,
  catalog: PlanCatalog = PLAN_CATALOG,
): Promise<Entitlements> {
  const subscription = await withDb((db) => billing(db, { orgId }).subscription())
  return entitlementsFor(subscription, catalog)
}
