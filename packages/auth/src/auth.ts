import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins'
import { schema, type Db } from '@saas-foundation/db'

export type InvitationNotice = { id: string; email: string; organizationName: string }

export type AuthOptions = {
  /** Per-request Drizzle client (ADR-0003: one pg client per request, uncached `DB` binding). */
  db: Db
  secret: string
  baseURL: string
  /**
   * Receives Better Auth's own log lines (level + message only; its extra arguments can hold request
   * data, so they're dropped). The app routes them to its structured logger (ADR-0015).
   */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: unknown) => void
  /** Delivers invitation links. No email provider yet (Q7): the app logs/returns the link. */
  onInvitation?: (notice: InvitationNotice) => Promise<void> | void
}

const loginRule = (request: Request) => request.method === 'POST' && { window: 60, max: 5 }

/**
 * Identity only (ADR-0005): users, sessions, organizations, members, invitations.
 * Authorization decisions live in the app (`getTenantContext`), not here.
 */
export function createAuth({ db, secret, baseURL, log, onInvitation }: AuthOptions) {
  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true },
    logger: {
      level: 'warn',
      ...(log && { log: (level, message: unknown) => log(level, message) }),
    },
    // Cloudflare's edge sets cf-connecting-ip (overwriting any client value). Without a trusted IP,
    // Better Auth puts every client into one shared rate-limit bucket.
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
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
        async sendInvitationEmail(data) {
          await onInvitation?.({
            id: data.id,
            email: data.email,
            organizationName: data.organization.name,
          })
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
