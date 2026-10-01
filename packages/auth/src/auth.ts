import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { captcha, organization } from 'better-auth/plugins'
import { countMembers, findMembership, schema, type Db } from '@saas-foundation/db'

/**
 * Emails Better Auth asks the app to send (ADR-0016). The app renders and delivers them; links that
 * carry a token put it in the query string, which logs redact (ADR-0015).
 */
export type AuthEmail =
  | { kind: 'invitation'; to: string; invitationId: string; organizationName: string }
  | { kind: 'password-reset'; to: string; url: string }
  | { kind: 'verification'; to: string; url: string }

/**
 * Unauthenticated endpoints that create accounts, try passwords or send email: each needs a bot
 * check (ADR-0025). Better Auth's captcha defaults plus `/send-verification-email`, which needs no
 * session and sends mail (our UI never calls it; sign-in resends the link instead).
 */
export const BOT_PROTECTED_PATHS = [
  '/sign-up/email',
  '/sign-in/email',
  '/request-password-reset',
  '/send-verification-email',
]

/**
 * ADR-0025: Cloudflare Turnstile on `BOT_PROTECTED_PATHS`, or `'unavailable'` when the deployment
 * isn't configured for it, which refuses those paths (503) instead of skipping the check.
 */
export type BotProtection =
  | {
      secretKey: string
      allowedHostnames?: string[]
      /**
       * Only requests to this host (`host[:port]`) may use these keys; any other host gets the 503.
       * For test keys, whose tokens carry no usable hostname, so they can't serve another domain.
       */
      requestHost?: string
    }
  | 'unavailable'

export type AuthOptions = {
  /** Per-request Drizzle client (ADR-0003: one pg client per request, uncached `DB` binding). */
  db: Db
  secret: string
  baseURL: string
  /**
   * Who may create an account (ADR-0014 data gate). Checked before Better Auth creates any user,
   * whatever the sign-up path. Required, so every caller decides explicitly.
   */
  allowSignUp: (email: string) => boolean
  /**
   * ADR-0016: email+password sign-in and invitation actions need a verified address. Required, so
   * every caller decides explicitly; only deployments that can't send email (previews) turn it off.
   */
  requireEmailVerification: boolean
  /**
   * Receives Better Auth's own log lines (level + message only; its extra arguments can hold request
   * data, so they're dropped). The app routes them to its structured logger (ADR-0015).
   */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: unknown) => void
  /** Bot check on sign-up, sign-in and email-sending endpoints. Required: there is no "off". */
  botProtection: BotProtection
  /** Delivers auth emails (invitation, password reset, verification). */
  sendEmail: (email: AuthEmail) => Promise<void>
  /**
   * Runs Better Auth's background work (email sends among it) after the response, e.g. the Worker's
   * `waitUntil`. Without it Better Auth awaits the send, and a reset request for an existing account
   * would take measurably longer than for an unknown one (account enumeration by timing).
   */
  runInBackground?: (promise: Promise<unknown>) => void
  /**
   * The app's billing policy, asked by Better Auth's own endpoints so no path bypasses it
   * (ADR-0020). Without it: Better Auth's default member limit, and deletion is never refused.
   */
  billing?: {
    /** Seats the organization's plan allows (null = unlimited). */
    memberLimit: (organizationId: string) => Promise<number | null>
    /** True while the organization must not be deleted (e.g. a live subscription). */
    blocksDeletion: (organizationId: string) => Promise<boolean>
    /**
     * The billing provider's own logins, kept in step with the owner role (ADR-0022: revoke before,
     * grant after). `revoke` throws when access can't be removed, and the change is refused.
     * Without it, owner changes touch nothing outside Better Auth.
     */
    members?: {
      revoke: (organizationId: string, userId: string) => Promise<void>
      grant: (organizationId: string, userId: string) => Promise<void>
      removeAccount: (organizationId: string) => Promise<void>
    }
  }
}

/**
 * Better Auth may store several comma-separated roles (and accepts an array in role updates); the
 * app's capability matrix reads their union, so "owner,admin" is an owner here too.
 */
const isOwner = (role: string | string[] | undefined | null) =>
  (Array.isArray(role) ? role : String(role ?? '').split(','))
    .map((r) => r.trim())
    .includes('owner')

const loginRule = (request: Request) => request.method === 'POST' && { window: 60, max: 5 }

/**
 * Identity only (ADR-0005): users, sessions, organizations, members, invitations.
 * Authorization decisions live in the app (`getTenantContext`), not here.
 */
export function createAuth({
  db,
  secret,
  baseURL,
  allowSignUp,
  requireEmailVerification,
  botProtection,
  log,
  sendEmail,
  runInBackground,
  billing: billingPolicy,
}: AuthOptions) {
  const blocksDeletion = (orgId: string) => billingPolicy?.blocksDeletion(orgId) ?? false
  const members = billingPolicy?.members
  // Fail closed: an owner who can't be removed from the billing account keeps the role.
  const revoke = async (orgId: string, userId: string) => {
    if (!members) return
    try {
      await members.revoke(orgId, userId)
    } catch {
      log?.('warn', 'billing.members.revoke_failed')
      throw billingAccessUnavailable()
    }
  }
  // Fails toward less access; the next checkout or portal call repairs a missing grant.
  const grant = async (orgId: string, userId: string) => {
    try {
      await members?.grant(orgId, userId)
    } catch {
      log?.('warn', 'billing.members.grant_failed')
    }
  }
  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: {
      enabled: true,
      // Our own page, token in the query string (Better Auth's default link has it in the path,
      // which request logs keep).
      async sendResetPassword({ user, token }) {
        const url = `${baseURL}/reset-password?token=${encodeURIComponent(token)}`
        await sendEmail({ kind: 'password-reset', to: user.email, url })
      },
      revokeSessionsOnPasswordReset: true,
      // ADR-0016: no session until the address is verified. Sign-up then answers the same for new
      // and existing addresses, and a sign-in with the right password resends the link.
      requireEmailVerification,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      // A session always needs the password, even after following the link.
      autoSignInAfterVerification: false,
      async sendVerificationEmail({ user, url }) {
        await sendEmail({ kind: 'verification', to: user.email, url })
      },
    },
    hooks: {
      // ADR-0018/0020: refuse deleting an organization the billing policy protects BEFORE Better
      // Auth's endpoint runs (it clears the caller's active organization before its own hooks).
      // Only for members: anyone else gets Better Auth's usual error, so billing state can't be
      // probed.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/organization/delete' && ctx.path !== '/organization/leave') return
        const orgId = (ctx.body as { organizationId?: unknown } | undefined)?.organizationId
        if (typeof orgId !== 'string' || !orgId) return
        const session = await getSessionFromCtx(ctx)
        const membership = session && (await findMembership(db, orgId, session.user.id))
        if (!session || !membership) return
        if (ctx.path === '/organization/delete') {
          if (await blocksDeletion(orgId)) throw billingStateConflict()
          return
        }
        // ADR-0022: an owner leaving loses billing access first.
        if (isOwner(membership.role)) await revoke(orgId, session.user.id)
      }),
    },
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            if (!allowSignUp(user.email)) {
              throw new APIError('FORBIDDEN', { message: 'Sign-up is closed' })
            }
          },
        },
      },
    },
    logger: {
      level: 'warn',
      ...(log && {
        log: (level, message: unknown, ...args: unknown[]) =>
          log(level, isCaptchaFailure(level, args) ? 'auth.captcha_unavailable' : message),
      }),
    },
    // Cloudflare's edge sets cf-connecting-ip (overwriting any client value). Without a trusted IP,
    // Better Auth puts every client into one shared rate-limit bucket.
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      ...(runInBackground && { backgroundTasks: { handler: runInBackground } }),
    },
    // Login rate limiting (ADR-0005): counters in Postgres, since memory is per isolate. Enabled in
    // every environment (Better Auth's default is production only). Per IP and path.
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      // POST only: other methods on these paths don't reach a handler and mustn't fill the bucket.
      customRules: {
        '/sign-in/email': loginRule,
        '/sign-up/email': loginRule,
      },
    },
    plugins: [
      // Runs after the rate limit (Better Auth's router order), so the limit also caps siteverify
      // calls. A siteverify error or timeout answers 500: fail closed.
      ...(botProtection === 'unavailable'
        ? [refuseBotProtectedPaths(() => true)]
        : [
            ...(botProtection.requestHost
              ? [
                  refuseBotProtectedPaths((url) => {
                    if (url.host === botProtection.requestHost) return false
                    log?.('warn', 'auth.turnstile_wrong_host')
                    return true
                  }),
                ]
              : []),
            captcha({
              provider: 'cloudflare-turnstile',
              secretKey: botProtection.secretKey,
              endpoints: BOT_PROTECTED_PATHS,
              allowedHostnames: botProtection.allowedHostnames,
            }),
          ]),
      organization({
        // ADR-0016: accepting (or rejecting) an invitation needs a verified address, which also
        // covers sessions created before verification was enforced.
        requireEmailVerificationOnInvitation: requireEmailVerification,
        organizationHooks: {
          // Backstop for deletions that don't come through the HTTP middleware above.
          async beforeDeleteOrganization({ organization }) {
            if (await blocksDeletion(organization.id)) throw billingStateConflict()
            // ADR-0022: only here, after Better Auth's own permission check (the middleware above
            // runs before it). The billing account goes first; if it can't, nothing is deleted.
            if (!members) return
            try {
              await members.removeAccount(organization.id)
            } catch {
              log?.('warn', 'billing.members.remove_account_failed')
              throw billingAccessUnavailable()
            }
          },
          // ADR-0022: revoke before, grant after, on every path that changes who is an owner.
          async beforeUpdateMemberRole({ member, newRole, organization }) {
            if (isOwner(member.role) && !isOwner(newRole))
              await revoke(organization.id, member.userId)
          },
          async afterUpdateMemberRole({ member, previousRole, organization }) {
            if (isOwner(member.role) && !isOwner(previousRole))
              await grant(organization.id, member.userId)
          },
          async beforeRemoveMember({ member, organization }) {
            if (isOwner(member.role)) await revoke(organization.id, member.userId)
          },
          async afterAddMember({ member, organization }) {
            if (isOwner(member.role)) await grant(organization.id, member.userId)
          },
          async afterAcceptInvitation({ member, organization }) {
            if (isOwner(member.role)) await grant(organization.id, member.userId)
          },
        },
        // Seat limits from the plan (ADR-0020). Accepting an invitation (or adding a member) fails
        // at the limit; pending invitations can't exceed the free seats. Better Auth counts, then
        // inserts, without a lock: simultaneous acceptances can exceed the cap by their number
        // (accepted for flat pricing; per-seat billing would need a database-enforced cap).
        ...(billingPolicy && {
          membershipLimit: async (_user, org) =>
            (await billingPolicy.memberLimit(org.id)) ?? Number.MAX_SAFE_INTEGER,
          invitationLimit: async ({ organization: org }) => {
            const limit = await billingPolicy.memberLimit(org.id)
            if (limit === null) return Number.MAX_SAFE_INTEGER // unlimited: no pending cap either
            return Math.max(0, limit - (await countMembers(db, org.id)))
          },
        }),
        async sendInvitationEmail(data) {
          await sendEmail({
            kind: 'invitation',
            to: data.email,
            invitationId: data.id,
            organizationName: data.organization.name,
          })
        },
      }),
    ],
  })
}

/**
 * The captcha plugin's own failure (siteverify unreachable, erroring or timing out; it answers 500):
 * logged at error level with the protected endpoint's URL. Its message is whatever was thrown, so
 * it gets a stable event name instead.
 */
const isCaptchaFailure = (level: string, args: unknown[]) => {
  const endpoint = (args[0] as { endpoint?: unknown } | undefined)?.endpoint
  if (level !== 'error' || typeof endpoint !== 'string') return false
  return BOT_PROTECTED_PATHS.some((path) => new URL(endpoint).pathname.endsWith(path))
}

/**
 * Refuses (503) protected-path requests for which `refuse(url)` holds: all of them when bot
 * protection isn't configured (refuse, never skip), or those to the wrong host for test keys.
 */
const refuseBotProtectedPaths = (refuse: (url: URL) => boolean): BetterAuthPlugin => ({
  id: 'captcha-unavailable',
  onRequest: async (request, ctx) => {
    const base = ctx.options.basePath ?? '/api/auth'
    const url = new URL(request.url)
    const path = url.pathname.replace(base, '').replace(/\/+$/, '')
    if (!BOT_PROTECTED_PATHS.includes(path) || !refuse(url)) return
    return {
      response: Response.json(
        { code: 'CAPTCHA_UNAVAILABLE', message: 'Sign-in is temporarily unavailable.' },
        { status: 503 },
      ),
    }
  },
})

const billingAccessUnavailable = () =>
  new APIError('SERVICE_UNAVAILABLE', {
    message: "Billing access couldn't be updated. Try again in a moment.",
  })

const billingStateConflict = () =>
  new APIError('CONFLICT', {
    message: 'This organization has an active subscription. Cancel it in Billing first.',
  })

export type Auth = ReturnType<typeof createAuth>
