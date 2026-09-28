import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { acceptInvitation, createOrganization, inviteMember } from './service'

const headers = () => new Headers(getRequestHeaders() as HeadersInit)
const passthrough = (data: unknown) => data

export const createOrganizationFn = createServerFn({ method: 'POST' })
  .inputValidator(passthrough)
  .handler(({ data }) => createOrganization(headers(), data))
export const inviteMemberFn = createServerFn({ method: 'POST' })
  .inputValidator(passthrough)
  .handler(({ data }) => inviteMember(headers(), data))
export const acceptInvitationFn = createServerFn({ method: 'POST' })
  .inputValidator(passthrough)
  .handler(({ data }) => acceptInvitation(headers(), data))
