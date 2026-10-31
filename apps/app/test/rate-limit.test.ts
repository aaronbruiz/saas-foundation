import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { authFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { rawDb } from '@saas-foundation/db/internal'
import { authPost, PASSWORD, randomIp, signUp } from './helpers'
import { captchaHeader } from './turnstile-fake'

// Login rate limiting (ADR-0005): 5 requests per 60 s per IP on sign-in and sign-up, counted in
// Postgres (the memory limiter is per isolate, so it can't hold across Workers).
const LIMIT = 5
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

const counterRow = (key: string) =>
  withDb((db) => rawDb(db).query.rateLimit.findFirst({ where: (t, { eq }) => eq(t.key, key) }))

async function statuses(n: number, request: () => Promise<Response>) {
  const out: Response[] = []
  for (let i = 0; i < n; i++) out.push(await request())
  return out
}

describe('login rate limiting', () => {
  it('limits sign-in per IP and returns 429 with a retry hint', async () => {
    const { email } = await signUp()
    const ip = randomIp()
    const signIn = () => authPost('/sign-in/email', { email, password: 'wrong-password-123' }, ip)
    const res = await statuses(LIMIT + 1, signIn)
    expect(res.slice(0, LIMIT).map((r) => r.status)).toEqual(Array(LIMIT).fill(401))
    const limited = res[LIMIT]!
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('X-Retry-After'))).toBeGreaterThan(0)
    // The correct password is also refused while limited: no bypass by guessing right.
    expect((await authPost('/sign-in/email', { email, password: PASSWORD }, ip)).status).toBe(429)
    // The counter lives in Postgres, not in isolate memory.
    await expect(counterRow(`${ip}|/sign-in/email`)).resolves.toMatchObject({ count: LIMIT })
  })

  it('does not limit a different IP', async () => {
    const { email } = await signUp()
    const ip = randomIp()
    await statuses(LIMIT + 1, () =>
      authPost('/sign-in/email', { email, password: 'wrong-password-123' }, ip),
    )
    expect(
      (await authPost('/sign-in/email', { email, password: PASSWORD }, randomIp())).status,
    ).toBe(200)
  })

  it('still limits (never errors or skips) a request without cf-connecting-ip', async () => {
    // No trusted IP: Better Auth uses a fallback bucket (127.0.0.1 in dev/test, one shared bucket
    // in production). The bucket may already be warm from an earlier run, so only the shape is fixed.
    const { email } = await signUp()
    const signIn = () =>
      withDb((db) =>
        authFor(db).handler(
          new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: env.BETTER_AUTH_URL,
              ...captchaHeader,
            },
            body: JSON.stringify({ email, password: 'wrong-password-123' }),
          }),
        ),
      )
    const codes = (await statuses(LIMIT + 1, signIn)).map((r) => r.status)
    expect(codes.every((c) => c === 401 || c === 429)).toBe(true)
    expect(codes.at(-1)).toBe(429)
  })

  it('counts only POSTs toward the sign-in limit', async () => {
    const { email } = await signUp()
    const ip = randomIp()
    const get = () =>
      withDb((db) =>
        authFor(db).handler(
          new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
            headers: { origin: env.BETTER_AUTH_URL, 'cf-connecting-ip': ip },
          }),
        ),
      )
    await statuses(LIMIT + 1, get)
    expect((await authPost('/sign-in/email', { email, password: PASSWORD }, ip)).status).toBe(200)
  })

  it('limits account deletion per IP: the sixth request gets 429 and the password is not checked', async () => {
    const user = await signUp()
    const ip = randomIp()
    const attempt = (password: string) => authPost('/delete-account', { password }, ip, user)
    const res = await statuses(LIMIT, () => attempt('wrong-password-123'))
    expect(res.map((r) => r.status)).toEqual(Array(LIMIT).fill(401))
    expect((await attempt(PASSWORD)).status).toBe(429)
    expect(await counterRow(`${ip}|/delete-account`)).toBeTruthy()
    const { rows } = await withDb((db) =>
      (rawDb(db) as unknown as { $client: { query: Query } }).$client.query(
        'SELECT count(*)::int AS n FROM user_deletion WHERE user_id = $1',
        [user.userId],
      ),
    )
    expect(rows[0]!.n).toBe(0)
  })

  it('does not limit account deletion from a different IP', async () => {
    const user = await signUp()
    const ip = randomIp()
    await statuses(LIMIT + 1, () =>
      authPost('/delete-account', { password: 'wrong-password-123' }, ip, user),
    )
    const other = await authPost(
      '/delete-account',
      { password: 'wrong-password-123' },
      randomIp(),
      user,
    )
    expect(other.status).toBe(401)
  })

  it('counts only POSTs toward the account deletion limit', async () => {
    const user = await signUp()
    const ip = randomIp()
    const get = () =>
      withDb((db) =>
        authFor(db).handler(
          new Request(`${env.BETTER_AUTH_URL}/api/auth/delete-account`, {
            headers: { 'cf-connecting-ip': ip },
          }),
        ),
      )
    await statuses(LIMIT + 1, get)
    expect(
      (await authPost('/delete-account', { password: 'wrong-password-123' }, ip, user)).status,
    ).toBe(401)
  })

  it('limits sign-up per IP and returns 429', async () => {
    const ip = randomIp()
    const res = await statuses(LIMIT + 1, () => {
      const email = `u-${crypto.randomUUID()}@test.local`
      return authPost('/sign-up/email', { email, password: PASSWORD, name: email }, ip)
    })
    expect(res.slice(0, LIMIT).map((r) => r.status)).toEqual(Array(LIMIT).fill(200))
    expect(res[LIMIT]!.status).toBe(429)
  })
})
