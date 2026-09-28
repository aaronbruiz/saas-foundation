import { env, waitUntil } from 'cloudflare:workers'
import { createAuth } from '@saas-foundation/auth'
import { billing, type Db } from '@saas-foundation/db'
import { entitlementsFor, isLive } from '../modules/billing/policy'
import { mailerFor, render, type EmailConfig } from './email'
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
  const mailer = mailerFor(env as unknown as EmailConfig)
  return createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    allowSignUp: signUpPolicy(vars.SIGNUP_MODE, vars.SIGNUP_ALLOWLIST),
    log: logBetterAuth,
    // ADR-0016. Invitations also return their link to the inviter (inviteMember).
    sendEmail: (email) => mailer(render(email, invitationLink)),
    // Failures are already logged by the mailer; don't let them surface as unhandled rejections.
    runInBackground: (p) => waitUntil(p.catch(() => {})),
    // Better Auth's organization endpoints ask the billing policy (ADR-0020).
    billing: {
      memberLimit: async (orgId) =>
        entitlementsFor(await billing(db, { orgId }).subscription()).limits.members,
      blocksDeletion: async (orgId) => isLive(await billing(db, { orgId }).subscription()),
    },
  })
}

export const invitationLink = (invitationId: string) =>
  `${env.BETTER_AUTH_URL}/invite/${encodeURIComponent(invitationId)}`
