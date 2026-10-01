import { env, waitUntil } from 'cloudflare:workers'
import { createAuth } from '@saas-foundation/auth'
import { billing, listOwners, type Db } from '@saas-foundation/db'
import { configuredMembers } from '../modules/billing/config'
import { entitlementsFor, isLive } from '../modules/billing/policy'
import { mailerFor, render, type EmailConfig } from './email'
import { logBetterAuth, logWarn } from './log'

/**
 * ADR-0014 sign-up gate. `SIGNUP_MODE=open` (dev, tests, previews, or production once public sign-up
 * is opened by its own ADR, a separate step after the data gate is lifted) admits anyone. Otherwise
 * only the exact addresses in `SIGNUP_ALLOWLIST` (comma-separated, case-insensitive) may sign up.
 * Unset means closed.
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

/**
 * ADR-0016: email verification is required unless `EMAIL_VERIFICATION` is exactly `off` **and** the
 * app runs on a workers.dev preview URL (previews send no email, so nobody could verify). An `off`
 * anywhere else is refused (logged) and verification stays on.
 */
export function emailVerificationRequired(setting: string | undefined, appUrl: string) {
  if (setting !== 'off') return true
  if (/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/.test(appUrl)) return false
  logWarn('auth.email_verification_off_refused')
  return true
}

const vars = env as unknown as {
  SIGNUP_MODE?: string
  SIGNUP_ALLOWLIST?: string
  EMAIL_VERIFICATION?: string
}

export function authFor(db: Db) {
  const mailer = mailerFor(env as unknown as EmailConfig)
  const members = configuredMembers()
  return createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    allowSignUp: signUpPolicy(vars.SIGNUP_MODE, vars.SIGNUP_ALLOWLIST),
    requireEmailVerification: emailVerificationRequired(
      vars.EMAIL_VERIFICATION,
      env.BETTER_AUTH_URL,
    ),
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
      // ADR-0022: the provider's billing logins follow the owner role.
      ...(members && {
        members: {
          revoke: async (orgId, userId) =>
            members.revoke(
              orgId,
              userId,
              (await listOwners(db, orgId)).filter((o) => o.userId !== userId),
            ),
          grant: async (orgId, userId) => {
            const owner = (await listOwners(db, orgId)).find((o) => o.userId === userId)
            if (owner) await members.grant(orgId, owner)
          },
          removeAccount: (orgId) => members.removeAccount(orgId),
        },
      }),
    },
  })
}

export const invitationLink = (invitationId: string) =>
  `${env.BETTER_AUTH_URL}/invite/${encodeURIComponent(invitationId)}`
