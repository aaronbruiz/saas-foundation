import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import {
  AcceptInvitationInput,
  CreateOrganizationInput,
  InviteMemberInput,
} from '@saas-foundation/contracts'
import { validateWith } from '../../server/validate'
import { acceptInvitation, createOrganization, inviteMember } from './service'

const headers = () => new Headers(getRequestHeaders() as HeadersInit)

export const createOrganizationFn = createServerFn({ method: 'POST' })
  .inputValidator(validateWith(CreateOrganizationInput))
  .handler(({ data }) => createOrganization(headers(), data))
export const inviteMemberFn = createServerFn({ method: 'POST' })
  .inputValidator(validateWith(InviteMemberInput))
  .handler(({ data }) => inviteMember(headers(), data))
export const acceptInvitationFn = createServerFn({ method: 'POST' })
  .inputValidator(validateWith(AcceptInvitationInput))
  .handler(({ data }) => acceptInvitation(headers(), data))
