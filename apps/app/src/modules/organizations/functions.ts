import { createServerFn } from '@tanstack/react-start'
import {
  AcceptInvitationInput,
  CreateOrganizationInput,
  InvitationRef,
  InviteMemberInput,
  TenantInput,
} from '@saas-foundation/contracts'
import { requestHeaders, serve } from '../../server/boundary'
import { validateWith } from '../../server/validate'
import {
  acceptInvitation,
  createOrganization,
  getTenant,
  getViewer,
  inviteMember,
  listInvitations,
  listMembers,
  revokeInvitation,
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
