import { APIError } from 'better-auth/api'
import {
  AcceptInvitationInput,
  CreateOrganizationInput,
  InviteMemberInput,
} from '@saas-foundation/contracts'
import { findOrganizationById } from '@saas-foundation/db'
import { TenantInput } from '@saas-foundation/contracts'
import { authFor, invitationLink } from '../../server/auth'
import { getTenantContext } from '../../server/context'
import { withDb } from '../../server/db'
import { HttpError, parseInput } from '../../server/errors'
import { authorize, capabilitiesOf, type Capability } from '../../server/permissions'

export async function createOrganization(
  headers: Headers,
  input: unknown,
): Promise<{ slug: string }> {
  const { name, slug } = parseInput(CreateOrganizationInput, input)
  return withDb(async (db) => {
    const auth = authFor(db)
    if (!(await auth.api.getSession({ headers }))) throw new HttpError(401, 'unauthorized')
    const org = await auth.api.createOrganization({ body: { name, slug }, headers })
    if (!org) throw new HttpError(409, 'organization not created')
    return { slug: org.slug }
  })
}

/** Needs `member:invite` (owner/admin). Returns the link; no email provider yet (Q7). */
export async function inviteMember(
  headers: Headers,
  input: unknown,
): Promise<{ invitationId: string; link: string }> {
  const { tenant, email, role } = parseInput(InviteMemberInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    authorize(ctx, 'member:invite')
    const invitation = await authFor(db).api.createInvitation({
      body: { email, role, organizationId: ctx.orgId },
      headers,
    })
    return { invitationId: invitation.id, link: invitationLink(invitation.id) }
  })
}

export async function acceptInvitation(
  headers: Headers,
  input: unknown,
): Promise<{ slug: string }> {
  const { invitationId } = parseInput(AcceptInvitationInput, input)
  return withDb(async (db) => {
    const auth = authFor(db)
    if (!(await auth.api.getSession({ headers }))) throw new HttpError(401, 'unauthorized')
    // Wrong recipient, unknown, expired or already used: all the same non-disclosing 404.
    const result = await auth.api
      .acceptInvitation({ body: { invitationId }, headers })
      .catch((e: unknown) => {
        // Only Better Auth's own 4xx rejections are "invalid invitation"; outages etc. propagate.
        if (e instanceof APIError && e.statusCode >= 400 && e.statusCode < 500) return null
        throw e
      })
    if (!result?.invitation) throw new HttpError(404, 'not found')
    const org = await findOrganizationById(db, result.invitation.organizationId)
    if (!org) throw new HttpError(404, 'not found')
    return { slug: org.slug }
  })
}

export type Viewer = {
  email: string
  name: string
  organizations: { slug: string; name: string }[]
}

/** The signed-in user and their organizations (for landing/navigation), or null if signed out. */
export async function getViewer(headers: Headers): Promise<Viewer | null> {
  return withDb(async (db) => {
    const auth = authFor(db)
    const session = await auth.api.getSession({ headers })
    if (!session) return null
    const orgs = await auth.api.listOrganizations({ headers })
    return {
      email: session.user.email,
      name: session.user.name,
      organizations: orgs.map((o) => ({ slug: o.slug, name: o.name })),
    }
  })
}

/**
 * Tenant header info for /t/<slug> layouts; same boundary and 404 semantics as every call.
 * Membership alone is enough (no capability): it returns only what every member may see about
 * their own tenant. The capabilities only let the UI hide actions; every server function checks
 * them again.
 */
export async function getTenant(
  headers: Headers,
  input: unknown,
): Promise<{ slug: string; name: string; role: string; capabilities: Capability[] }> {
  const { tenant } = parseInput(TenantInput, input)
  return withDb(async (db) => {
    const { slug, name, role } = await getTenantContext(db, headers, tenant)
    return { slug, name, role, capabilities: capabilitiesOf(role) }
  })
}
