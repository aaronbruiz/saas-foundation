import { env } from 'cloudflare:workers'
import { createAuth } from '@saas-foundation/auth'
import type { Db } from '@saas-foundation/db'
import { redact } from './log'

export function authFor(db: Db) {
  return createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    log: (level, message) => {
      const line = JSON.stringify({ level, event: 'better_auth', message: redact(message) })
      if (level === 'error') console.error(line)
      else console.warn(line)
    },
    // No email provider yet (Q7): the inviter gets the link from inviteMember(); nothing is logged.
  })
}

export const invitationLink = (invitationId: string) =>
  `${env.BETTER_AUTH_URL}/invite/${encodeURIComponent(invitationId)}`
