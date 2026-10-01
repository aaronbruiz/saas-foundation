import { env } from 'cloudflare:workers'
import { createEmailVerificationToken } from 'better-auth/api'
import { authFor } from '../src/server/auth'
import { findOrganizationBySlug } from '@saas-foundation/db'
import { withDb } from '../src/server/db'
import {
  acceptInvitation,
  createOrganization,
  inviteMember,
} from '../src/modules/organizations/service'

export type TestUser = { headers: Headers; userId: string; email: string }

export const PASSWORD = 'correct-horse-battery-staple'

/**
 * A random client IP. Login rate limits count per IP (ADR-0005), so each simulated client gets
 * its own; rows persist in `app_test` across runs, so a fixed IP would carry counts over.
 */
export const randomIp = () =>
  `10.${Array.from(crypto.getRandomValues(new Uint8Array(3))).join('.')}`

/** POSTs JSON to a Better Auth endpoint through the real HTTP handler, as client `ip`. */
export function authPost(path: string, body: unknown, ip = randomIp(), as?: TestUser) {
  return withDb((db) =>
    authFor(db).handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: env.BETTER_AUTH_URL,
          'cf-connecting-ip': ip,
          ...(as && { cookie: as.headers.get('cookie')! }),
        },
        body: JSON.stringify(body),
      }),
    ),
  )
}

/** The link a verification email carries (ADR-0016), signed with the test secret. */
export async function verificationUrl(email: string) {
  const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, email)
  return `${env.BETTER_AUTH_URL}/api/auth/verify-email?token=${token}`
}

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

/**
 * Signs up through the real Better Auth HTTP handler, follows the verification link (ADR-0016: no
 * session before that) and signs in, returning the session cookie.
 */
export async function signUp(): Promise<TestUser> {
  const email = `u-${crypto.randomUUID()}@test.local`
  const res = await authPost('/sign-up/email', { email, password: PASSWORD, name: email })
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`)
  const link = await verificationUrl(email)
  // Its own client IP: without one, every verification shares Better Auth's `no-trusted-ip` bucket
  // (100/min, persisted in app_test), which back-to-back runs overflow with 429s.
  const verified = await withDb((db) =>
    authFor(db).handler(new Request(link, { headers: { 'cf-connecting-ip': randomIp() } })),
  )
  if (!verified.ok) throw new Error(`verification failed: ${verified.status}`)
  const signIn = await authPost('/sign-in/email', { email, password: PASSWORD })
  if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`)
  const body = (await signIn.json()) as { user: { id: string } }
  return {
    headers: new Headers({ cookie: cookieOf(signIn), origin: env.BETTER_AUTH_URL }),
    userId: body.user.id,
    email,
  }
}

/** Creates an organization owned by `user` with a unique slug. */
export async function createOrg(user: TestUser, prefix = 'org'): Promise<string> {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  await createOrganization(user.headers, { name: slug, slug })
  return slug
}

/** Signs up a new user and makes them a `role` member of `slug` through a real invitation. */
export async function joinAs(owner: TestUser, slug: string, role: 'admin' | 'member') {
  const user = await signUp()
  const { invitationId } = await inviteMember(owner.headers, {
    tenant: slug,
    email: user.email,
    role,
  })
  await acceptInvitation(user.headers, { invitationId })
  return user
}

/** Asserts that `fn` rejects with an HttpError of the given status. */
export async function expectStatus(fn: () => Promise<unknown>, status: number) {
  try {
    await fn()
  } catch (e) {
    const actual = (e as { status?: number }).status
    if (actual === status) return
    throw new Error(`expected HTTP ${status}, got ${actual ?? String(e)}`)
  }
  throw new Error(`expected HTTP ${status}, but the call succeeded`)
}

/**
 * Test fixture: puts an organization on a paid plan with room for many projects and members, so
 * tests about other rules aren't limited by the default plan (ADR-0020). In the app, billing state
 * comes only from verified webhooks (test/billing.test.ts covers that path).
 */
export async function onPaidPlan(slug: string, planKey = 'pro') {
  await withDb(async (db) => {
    const org = await findOrganizationBySlug(db, slug)
    if (!org) throw new Error(`no organization ${slug}`)
    await (
      db as unknown as { $client: { query: (q: string, p: unknown[]) => Promise<unknown> } }
    ).$client.query(
      `INSERT INTO billing_subscription (organization_id, provider, provider_customer_id,
           provider_subscription_id, plan_key, status, provider_event_at)
         VALUES ($1, 'test', $2, $3, $4, 'active', now())
         ON CONFLICT (organization_id) DO UPDATE SET plan_key = $4, status = 'active'`,
      [org.id, `cus_fixture_${org.id}`, `sub_fixture_${org.id}`, planKey],
    )
  })
}
