import { env } from 'cloudflare:workers'
import { authFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { createOrganization } from '../src/modules/organizations/service'

export type TestUser = { headers: Headers; userId: string; email: string }

/** Signs up through the real Better Auth HTTP handler and returns the session cookie. */
export async function signUp(): Promise<TestUser> {
  const email = `u-${crypto.randomUUID()}@test.local`
  const res = await withDb((db) =>
    authFor(db).handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: env.BETTER_AUTH_URL },
        body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: email }),
      }),
    ),
  )
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
