import { env, waitUntil } from 'cloudflare:workers'
import { createAuth, type BotProtection } from '@saas-foundation/auth'
import { billing, listOwners, type Db } from '@saas-foundation/db'
import { configuredMembers } from '../modules/billing/config'
import { entitlementsFor, isLive } from '../modules/billing/policy'
import { mailerFor, render } from './email'
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
  if (isPreviewUrl(appUrl)) return false
  logWarn('auth.email_verification_off_refused')
  return true
}

const isPreviewUrl = (appUrl: string) =>
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/.test(appUrl)
const isLocalUrl = (appUrl: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(appUrl)

/**
 * Cloudflare's documented Turnstile test keys (site `1x00000000000000000000AA`, secret
 * `1x0000000000000000000000000000000AA` and their always-fail/spent variants): they pass or fail
 * without a real challenge.
 */
const TEST_KEY = /^[123]x0{20,}[A-F]{2}$/

/**
 * ADR-0025: Turnstile needs both keys. Test keys only on localhost and workers.dev previews; a
 * missing key, or a test key anywhere else, makes the protected endpoints refuse (503, logged)
 * rather than skip the check. With real keys the token must also have been issued for this app's
 * hostname (a test key's token reports `example.com`) and carry its form's action.
 */
export function botProtectionFor(
  secretKey: string | undefined,
  siteKey: string | undefined,
  appUrl: string,
): BotProtection {
  if (!secretKey || !siteKey) {
    logWarn('auth.turnstile_misconfigured', { reason: 'missing_key' })
    return 'unavailable'
  }
  const testKeys = TEST_KEY.test(secretKey) || TEST_KEY.test(siteKey)
  if (!testKeys)
    return { secretKey, allowedHostnames: [new URL(appUrl).hostname], checkAction: true }
  // Bound to the app's own host: a production Worker misconfigured with a preview or localhost
  // URL still refuses the dummy token on its real domain.
  if (isLocalUrl(appUrl) || isPreviewUrl(appUrl))
    return { secretKey, requestHost: new URL(appUrl).host }
  logWarn('auth.turnstile_misconfigured', { reason: 'test_key' })
  return 'unavailable'
}

// Partial: SIGNUP_MODE and the Turnstile keys are typed present (generated from .dev.vars.example),
// but production leaves SIGNUP_MODE unset by design and a missing Turnstile key must refuse.
const vars: Partial<Cloudflare.Env> = env

/** The Turnstile site key the auth pages render with, or null while bot protection is unavailable. */
export const turnstileSiteKey = () =>
  botProtectionFor(vars.TURNSTILE_SECRET_KEY, vars.TURNSTILE_SITE_KEY, env.BETTER_AUTH_URL) ===
  'unavailable'
    ? null
    : vars.TURNSTILE_SITE_KEY!

export function authFor(db: Db) {
  const mailer = mailerFor(env)
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
    botProtection: botProtectionFor(
      vars.TURNSTILE_SECRET_KEY,
      vars.TURNSTILE_SITE_KEY,
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
