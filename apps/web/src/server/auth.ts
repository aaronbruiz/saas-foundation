import { env } from 'cloudflare:workers'
import { createAuth } from '@saas-foundation/auth'
import type { Db } from '@saas-foundation/db'

export function authFor(db: Db) {
  return createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // No email provider yet (Q7): the inviter gets the link from inviteMember(); nothing is logged.
  })
}

export const invitationLink = (invitationId: string) =>
  `${env.BETTER_AUTH_URL}/invite/${encodeURIComponent(invitationId)}`
