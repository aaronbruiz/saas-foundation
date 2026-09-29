import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins'
import { countMembers, findMembership, schema, type Db } from '@saas-foundation/db'

/**
 * Emails Better Auth asks the app to send (ADR-0016). The app renders and delivers them; links that
 * carry a token put it in the query string, which logs redact (ADR-0015).
 */
export type AuthEmail =
  | { kind: 'invitation'; to: string; invitationId: string; organizationName: string }
  | { kind: 'password-reset'; to: string; url: string }
  | { kind: 'verification'; to: string; url: string }

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
   * Receives Better Auth's own log lines (level + message only; its extra arguments can hold request
   * data, so they're dropped). The app routes them to its structured logger (ADR-0015).
   */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: unknown) => void
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
    },
    // Sent on sign-up; not yet required to sign in (ADR-0016: enforced once production email works).
    emailVerification: {
      sendOnSignUp: true,
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
        if (membership.role === 'owner') await revoke(orgId, session.user.id)
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
      ...(log && { log: (level, message: unknown) => log(level, message) }),
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
      organization({
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
            if (member.role === 'owner' && newRole !== 'owner')
              await revoke(organization.id, member.userId)
          },
          async afterUpdateMemberRole({ member, previousRole, organization }) {
            if (member.role === 'owner' && previousRole !== 'owner')
              await grant(organization.id, member.userId)
          },
          async beforeRemoveMember({ member, organization }) {
            if (member.role === 'owner') await revoke(organization.id, member.userId)
          },
          async afterAddMember({ member, organization }) {
            if (member.role === 'owner') await grant(organization.id, member.userId)
          },
          async afterAcceptInvitation({ member, organization }) {
            if (member.role === 'owner') await grant(organization.id, member.userId)
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

const billingAccessUnavailable = () =>
  new APIError('SERVICE_UNAVAILABLE', {
    message: "Billing access couldn't be updated. Try again in a moment.",
  })

const billingStateConflict = () =>
  new APIError('CONFLICT', {
    message: 'This organization has an active subscription. Cancel it in Billing first.',
  })

export type Auth = ReturnType<typeof createAuth>
