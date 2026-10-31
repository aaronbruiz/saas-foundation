import { APIError } from 'better-auth/api'
import {
  AcceptInvitationInput,
  CreateOrganizationInput,
  DeleteOrganizationInput,
  InvitationRef,
  InviteMemberInput,
  MemberRef,
  RenameOrganizationInput,
  TransferOwnershipInput,
  UpdateMemberRoleInput,
} from '@saas-foundation/contracts'
import {
  cancelPendingInvitation,
  findMember,
  findMembership,
  findOrganizationById,
  findPendingInvitation,
  isOwnerGuardViolation,
  listMembers as membersOf,
  listOwners,
  listPendingInvitations,
  removeNonOwnerMember,
  updateNonOwnerMemberRole,
  type PendingInvitation,
} from '@saas-foundation/db'
import { TenantInput } from '@saas-foundation/contracts'
import { authFor, invitationLink } from '../../server/auth'
import { getTenantContext } from '../../server/context'
import { withDb } from '../../server/db'
import { HttpError, notFound, parseInput } from '../../server/errors'
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

export type Member = { id: string; name: string; email: string; role: string }

/** The tenant's members for the members page; every role has `member:read`. */
export async function listMembers(headers: Headers, input: unknown): Promise<Member[]> {
  const { tenant } = parseInput(TenantInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    authorize(ctx, 'member:read')
    return (await membersOf(db, ctx.orgId)).map(({ id, name, email, role }) => ({
      id,
      name,
      email,
      role,
    }))
  })
}

/** Pending, unexpired invitations; they go with `member:invite` (owner/admin). */
export async function listInvitations(
  headers: Headers,
  input: unknown,
): Promise<PendingInvitation[]> {
  const { tenant } = parseInput(TenantInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    authorize(ctx, 'member:invite')
    return listPendingInvitations(db, ctx.orgId)
  })
}

/**
 * Cancels a pending invitation of this tenant (`member:invite`). Another tenant's, unknown or no
 * longer pending invitation is a 404 before the role check. The cancel is a conditional write in
 * packages/db, not Better Auth's cancel, which overwrites any status (an acceptance racing it
 * would end up "canceled" with its membership kept); no organization hook covers cancelling.
 */
export async function revokeInvitation(headers: Headers, input: unknown): Promise<{ id: string }> {
  const { tenant, invitationId } = parseInput(InvitationRef, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    if (!(await findPendingInvitation(db, ctx.orgId, invitationId))) throw notFound()
    authorize(ctx, 'member:invite')
    if (!(await cancelPendingInvitation(db, ctx.orgId, invitationId))) throw notFound()
    return { id: invitationId }
  })
}

const ownerRowRefused = () => new HttpError(403, "An owner can't be changed here")

/**
 * Removes a non-owner of this tenant (`member:manage`), the caller included. Another tenant's or an
 * unknown member is a 404 before the role check. A conditional write in packages/db, not Better
 * Auth's endpoint, which checks and then deletes: a promotion racing it would lose an owner.
 */
export async function removeMember(
  headers: Headers,
  input: unknown,
): Promise<{ removedSelf: boolean }> {
  const { tenant, memberId } = parseInput(MemberRef, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    const target = await findMember(db, ctx.orgId, memberId)
    if (!target) throw notFound()
    authorize(ctx, 'member:manage')
    if (target.isOwner) throw ownerRowRefused()
    if (!(await removeNonOwnerMember(db, ctx.orgId, memberId))) throw notFound()
    return { removedSelf: target.userId === ctx.userId }
  })
}

/** Switches a non-owner between member and admin; the same checks as `removeMember`. */
export async function updateMemberRole(headers: Headers, input: unknown): Promise<{ id: string }> {
  const { tenant, memberId, role } = parseInput(UpdateMemberRoleInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    const target = await findMember(db, ctx.orgId, memberId)
    if (!target) throw notFound()
    authorize(ctx, 'member:manage')
    if (target.isOwner) throw ownerRowRefused()
    if (!(await updateNonOwnerMemberRole(db, ctx.orgId, memberId, role))) throw notFound()
    return { id: memberId }
  })
}

const LOST_MEMBERSHIP = ['MEMBER_NOT_FOUND', 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION']
const NOT_ALLOWED = [
  'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER',
  'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION',
  'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER',
]
const LAST_OWNER = [
  'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER',
  'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER',
]

/**
 * What a refused owner change or deletion tells the caller, each case by name: the state changed
 * after `getTenantContext`, a billing hook refused, or the trigger failed the commit (a database
 * error, ADR-0043). Anything else is unexpected and propagates, never a conflict to retry.
 */
export function refusal(e: unknown): HttpError {
  if (isOwnerGuardViolation(e))
    return new HttpError(
      409,
      'Another owner changed at the same time. Check the members and retry.',
    )
  if (!(e instanceof APIError)) throw e
  const code = String(e.body?.code)
  if (e.statusCode === 401) return new HttpError(401, 'unauthorized')
  if (LOST_MEMBERSHIP.includes(code)) return notFound()
  if (NOT_ALLOWED.includes(code)) return new HttpError(403, e.message)
  if (LAST_OWNER.includes(code)) return new HttpError(409, e.message)
  // The billing hooks' own refusals (packages/auth), each with its message.
  if (e.statusCode === 409 || e.statusCode === 503) return new HttpError(e.statusCode, e.message)
  throw e
}

/** Only the display name (owner, admin). Better Auth's own endpoint can also change the slug. */
export async function renameOrganization(
  headers: Headers,
  input: unknown,
): Promise<{ name: string }> {
  const { tenant, name } = parseInput(RenameOrganizationInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    authorize(ctx, 'organization:rename')
    await authFor(db).api.updateOrganization({
      body: { organizationId: ctx.orgId, data: { name } },
      headers,
    })
    return { name }
  })
}

/**
 * Makes an existing member an owner, then the caller an admin (owner decision 2026-10-31). Two
 * Better Auth updates, so ADR-0022's hooks run on each: grant after, revoke before. Not atomic: the
 * promotion comes first, so a failure in between leaves two owners, never none, and a retry finds
 * the target already an owner and finishes.
 */
export async function transferOwnership(headers: Headers, input: unknown): Promise<{ id: string }> {
  const { tenant, memberId } = parseInput(TransferOwnershipInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    const target = await findMember(db, ctx.orgId, memberId)
    if (!target) throw notFound()
    authorize(ctx, 'organization:transfer')
    if (target.userId === ctx.userId) throw new HttpError(400, 'Choose another member')
    const auth = authFor(db)
    const setRole = (id: string, role: 'owner' | 'admin') =>
      auth.api.updateMemberRole({
        body: { memberId: id, role, organizationId: ctx.orgId },
        headers,
      })
    if (!target.isOwner)
      await setRole(memberId, 'owner').catch((e: unknown) => {
        throw refusal(e)
      })
    const self = await findMembership(db, ctx.orgId, ctx.userId)
    if (!self) throw notFound()
    await setRole(self.id, 'admin').catch((e: unknown) => {
      const { status, message } = refusal(e)
      throw new HttpError(
        status,
        `The new owner is in place, but you're still an owner. ${message}`,
      )
    })
    return { id: memberId }
  })
}

const onlyOwner = () =>
  new HttpError(409, "You're the only owner. Transfer ownership or delete the organization first.")

/**
 * Any member. A sole owner is refused here, before the auth middleware's billing revoke, which
 * would answer 503 or cost them their billing access for a change that can't happen.
 */
export async function leaveOrganization(headers: Headers, input: unknown): Promise<{ left: true }> {
  const { tenant } = parseInput(TenantInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    const owners = await listOwners(db, ctx.orgId)
    if (owners.length === 1 && owners[0]!.userId === ctx.userId) throw onlyOwner()
    await authFor(db)
      .api.leaveOrganization({ body: { organizationId: ctx.orgId }, headers })
      .catch((e: unknown) => {
        if (
          e instanceof APIError &&
          e.body?.code === 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER'
        )
          throw onlyOwner()
        throw refusal(e)
      })
    return { left: true }
  })
}

/**
 * Owner only, with the organization's exact name typed in the app; direct HTTP keeps Better Auth's
 * owner-session requirement without it. The billing protections are Better Auth's hooks, so they
 * cover both paths (packages/auth, ADR-0043).
 */
export async function deleteOrganization(
  headers: Headers,
  input: unknown,
): Promise<{ deleted: true }> {
  const { tenant, confirmName } = parseInput(DeleteOrganizationInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    authorize(ctx, 'organization:delete')
    if (confirmName !== ctx.name)
      throw new HttpError(400, "That doesn't match the organization's name")
    await authFor(db)
      .api.deleteOrganization({ body: { organizationId: ctx.orgId }, headers })
      .catch((e: unknown) => {
        throw refusal(e)
      })
    return { deleted: true }
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
        // The plan's seat limit (ADR-0020). Better Auth checks it only after confirming the caller
        // is the invitation's recipient, so saying so discloses nothing.
        if (e instanceof APIError && e.body?.code === 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED')
          throw new HttpError(403, 'This organization has no free seats on its plan')
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
