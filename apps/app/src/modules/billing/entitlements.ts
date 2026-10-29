import { billing, type BillingSubscription, type Db } from '@saas-foundation/db'
import { entitlementsFor, type Entitlements } from './policy'

export type { Entitlements } from './policy'

/** `orgId` must come from a verified tenant context (`getTenantContext`), never from input. */
export async function entitlementsIn(db: Db, orgId: string): Promise<Entitlements> {
  return entitlementsFor(await billing(db, { orgId }).subscription())
}

/**
 * The same, for a subscription a repository read inside its own tenant transaction, under the
 * lock that enforces the limit (`projects.createWithinLimit`; ADR-0040 decision 8).
 */
export const entitlementsOfSubscription = (subscription: BillingSubscription | null) =>
  entitlementsFor(subscription)
