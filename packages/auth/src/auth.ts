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
  /** Delivers invitation links. No email provider yet (Q7): the app logs/returns the link. */
  onInvitation?: (notice: InvitationNotice) => Promise<void> | void
}

/**
 * Identity only (ADR-0005): users, sessions, organizations, members, invitations.
 * Authorization decisions live in the app (`getTenantContext`), not here.
 */
export function createAuth({ db, secret, baseURL, onInvitation }: AuthOptions) {
  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true },
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
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60, max: 5 },
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
