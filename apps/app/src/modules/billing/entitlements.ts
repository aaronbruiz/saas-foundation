import { billing, type Db } from '@saas-foundation/db'
import { entitlementsFor, type Entitlements } from './policy'

export type { Entitlements } from './policy'

/** `orgId` must come from a verified tenant context (`getTenantContext`), never from input. */
export async function entitlementsIn(db: Db, orgId: string): Promise<Entitlements> {
  return entitlementsFor(await billing(db, { orgId }).subscription())
}
