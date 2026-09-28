import { env } from 'cloudflare:workers'
import { createAuth } from '@saas-foundation/auth'
import type { Db } from '@saas-foundation/db'
import { logBetterAuth } from './log'

/**
 * ADR-0014 data gate. `SIGNUP_MODE=open` (dev, tests, previews, or production once the owner lifts
 * the gate) admits anyone. Otherwise only the exact addresses in `SIGNUP_ALLOWLIST`
 * (comma-separated, case-insensitive) may sign up. Unset means closed.
 */
export function signUpPolicy(mode: string | undefined, allowlist: string | undefined) {
  if (mode === 'open') return () => true
  const allowed = new Set(
    (allowlist ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
  return (email: string) => allowed.has(email.trim().toLowerCase())
}

const vars = env as unknown as { SIGNUP_MODE?: string; SIGNUP_ALLOWLIST?: string }

export function authFor(db: Db) {
  return createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    allowSignUp: signUpPolicy(vars.SIGNUP_MODE, vars.SIGNUP_ALLOWLIST),
    log: logBetterAuth,
    // No email provider yet (Q7): the inviter gets the link from inviteMember(); nothing is logged.
  })
}

export const invitationLink = (invitationId: string) =>
  `${env.BETTER_AUTH_URL}/invite/${encodeURIComponent(invitationId)}`
