import { createServerFn } from '@tanstack/react-start'
import {
  AcceptInvitationInput,
  CreateOrganizationInput,
  InviteMemberInput,
  TenantInput,
} from '@saas-foundation/contracts'
import { requestHeaders, serve } from '../../server/boundary'
import { validateWith } from '../../server/validate'
import { acceptInvitation, createOrganization, getTenant, getViewer, inviteMember } from './service'

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
