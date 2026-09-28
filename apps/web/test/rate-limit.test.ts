import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { authFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { authPost, PASSWORD, randomIp, signUp } from './helpers'

// Login rate limiting (ADR-0005): 5 requests per 60 s per IP on sign-in and sign-up, counted in
// Postgres (the memory limiter is per isolate, so it can't hold across Workers).
const LIMIT = 5

const counterRow = (key: string) =>
  withDb((db) => db.query.rateLimit.findFirst({ where: (t, { eq }) => eq(t.key, key) }))

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
            headers: { 'content-type': 'application/json', origin: env.BETTER_AUTH_URL },
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
