import { findMembership, findOrganizationBySlug, type Db } from '@saas-foundation/db'
import { TenantSlug } from '@saas-foundation/contracts'
import { authFor } from './auth'
import { HttpError, notFound } from './errors'

export type TenantContext = {
  userId: string
  email: string
  orgId: string
  slug: string
  name: string
  role: string
}

/**
 * The tenant boundary (AGENTS.md invariant 1, ADR-0010). The slug is a selector from the URL or a
 * server-function input; membership is verified on every call through the uncached DB.
 * No session → 401. Unknown slug, invalid slug or not a member → 404 (no existence disclosure).
 */
export async function getTenantContext(
  db: Db,
  headers: Headers,
  tenant: string,
): Promise<TenantContext> {
  const session = await authFor(db).api.getSession({ headers })
  if (!session) throw new HttpError(401, 'unauthorized')
  const slug = TenantSlug.safeParse(tenant)
  if (!slug.success) throw notFound()
  const org = await findOrganizationBySlug(db, slug.data)
  const membership = org && (await findMembership(db, org.id, session.user.id))
  if (!org || !membership) throw notFound()
  return {
    userId: session.user.id,
    email: session.user.email,
    orgId: org.id,
    slug: org.slug,
    name: org.name,
    role: membership.role,
  }
}
