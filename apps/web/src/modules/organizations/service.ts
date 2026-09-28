import {
  AcceptInvitationInput,
  CreateOrganizationInput,
  InviteMemberInput,
} from '@saas-foundation/contracts'
import { authFor, invitationLink } from '../../server/auth'
import { getTenantContext } from '../../server/context'
import { withDb } from '../../server/db'
import { HttpError, parseInput } from '../../server/errors'

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

/** Owner/admin only (Better Auth default roles). Returns the link; no email provider yet (Q7). */
export async function inviteMember(
  headers: Headers,
  input: unknown,
): Promise<{ invitationId: string; link: string }> {
  const { tenant, email, role } = parseInput(InviteMemberInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    if (ctx.role !== 'owner' && ctx.role !== 'admin') throw new HttpError(403, 'forbidden')
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
): Promise<{ organizationId: string }> {
  const { invitationId } = parseInput(AcceptInvitationInput, input)
  return withDb(async (db) => {
    const auth = authFor(db)
    if (!(await auth.api.getSession({ headers }))) throw new HttpError(401, 'unauthorized')
    const result = await auth.api.acceptInvitation({ body: { invitationId }, headers })
    if (!result?.invitation) throw new HttpError(404, 'not found')
    return { organizationId: result.invitation.organizationId }
  })
}
