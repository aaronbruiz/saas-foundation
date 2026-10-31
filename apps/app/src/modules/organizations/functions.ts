import { createServerFn } from '@tanstack/react-start'
import {
  AcceptInvitationInput,
  CreateOrganizationInput,
  DeleteOrganizationInput,
  InvitationRef,
  InviteMemberInput,
  MemberRef,
  RenameOrganizationInput,
  TenantInput,
  TransferOwnershipInput,
  UpdateMemberRoleInput,
} from '@saas-foundation/contracts'
import { requestHeaders, serve } from '../../server/boundary'
import { validateWith } from '../../server/validate'
import {
  acceptInvitation,
  createOrganization,
  deleteOrganization,
  getTenant,
  getViewer,
  inviteMember,
  leaveOrganization,
  listInvitations,
  listMembers,
  removeMember,
  renameOrganization,
  revokeInvitation,
  transferOwnership,
  updateMemberRole,
} from './service'

export const getViewerFn = createServerFn({ method: 'GET' }).handler(() =>
  serve(() => getViewer(requestHeaders())),
)
export const getTenantFn = createServerFn({ method: 'GET' })
  .validator(validateWith(TenantInput))
  .handler(({ data }) => serve(() => getTenant(requestHeaders(), data)))
export const createOrganizationFn = createServerFn({ method: 'POST' })
  .validator(validateWith(CreateOrganizationInput))
  .handler(({ data }) => serve(() => createOrganization(requestHeaders(), data)))
export const inviteMemberFn = createServerFn({ method: 'POST' })
  .validator(validateWith(InviteMemberInput))
  .handler(({ data }) => serve(() => inviteMember(requestHeaders(), data)))
export const acceptInvitationFn = createServerFn({ method: 'POST' })
  .validator(validateWith(AcceptInvitationInput))
  .handler(({ data }) => serve(() => acceptInvitation(requestHeaders(), data)))
export const listMembersFn = createServerFn({ method: 'GET' })
  .validator(validateWith(TenantInput))
  .handler(({ data }) => serve(() => listMembers(requestHeaders(), data)))
export const listInvitationsFn = createServerFn({ method: 'GET' })
  .validator(validateWith(TenantInput))
  .handler(({ data }) => serve(() => listInvitations(requestHeaders(), data)))
export const revokeInvitationFn = createServerFn({ method: 'POST' })
  .validator(validateWith(InvitationRef))
  .handler(({ data }) => serve(() => revokeInvitation(requestHeaders(), data)))
export const removeMemberFn = createServerFn({ method: 'POST' })
  .validator(validateWith(MemberRef))
  .handler(({ data }) => serve(() => removeMember(requestHeaders(), data)))
export const updateMemberRoleFn = createServerFn({ method: 'POST' })
  .validator(validateWith(UpdateMemberRoleInput))
  .handler(({ data }) => serve(() => updateMemberRole(requestHeaders(), data)))
export const renameOrganizationFn = createServerFn({ method: 'POST' })
  .validator(validateWith(RenameOrganizationInput))
  .handler(({ data }) => serve(() => renameOrganization(requestHeaders(), data)))
export const transferOwnershipFn = createServerFn({ method: 'POST' })
  .validator(validateWith(TransferOwnershipInput))
  .handler(({ data }) => serve(() => transferOwnership(requestHeaders(), data)))
export const leaveOrganizationFn = createServerFn({ method: 'POST' })
  .validator(validateWith(TenantInput))
  .handler(({ data }) => serve(() => leaveOrganization(requestHeaders(), data)))
export const deleteOrganizationFn = createServerFn({ method: 'POST' })
  .validator(validateWith(DeleteOrganizationInput))
  .handler(({ data }) => serve(() => deleteOrganization(requestHeaders(), data)))
