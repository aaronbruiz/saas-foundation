import { env } from 'cloudflare:workers'
import { authFor } from '../src/server/auth'
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

/** Signs up through the real Better Auth HTTP handler and returns the session cookie. */
export async function signUp(): Promise<TestUser> {
  const email = `u-${crypto.randomUUID()}@test.local`
  const res = await authPost('/sign-up/email', { email, password: PASSWORD, name: email })
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`)
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const body = (await res.json()) as { user: { id: string } }
  return {
    headers: new Headers({ cookie, origin: env.BETTER_AUTH_URL }),
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
