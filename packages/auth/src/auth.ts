import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins'
import { billing, schema, type Db } from '@saas-foundation/db'

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
}: AuthOptions) {
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
          // ADR-0018: what deleting an organization with billing state does is an open product
          // decision (the subscription would keep running). Until then it's refused explicitly;
          // the database's foreign key (RESTRICT) is the backstop.
          async beforeDeleteOrganization({ organization }) {
            if (await billing(db, { orgId: organization.id }).subscription())
              throw new APIError('CONFLICT', { message: 'Organization has billing state' })
          },
        },
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

export type Auth = ReturnType<typeof createAuth>
