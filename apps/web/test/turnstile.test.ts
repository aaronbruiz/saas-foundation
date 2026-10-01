import { env } from 'cloudflare:workers'
import { BOT_PROTECTED_PATHS, createAuth, type BotProtection } from '@saas-foundation/auth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { botProtectionFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { logBetterAuth } from '../src/server/log'
import { PASSWORD, randomIp, signUp } from './helpers'
import {
  DUMMY_TOKEN,
  FAIL_SECRET,
  PASS_SECRET,
  PASS_SITE_KEY,
  SPENT_SECRET,
  captchaHeader,
  siteverifyCalls,
  siteverifyOutage,
} from './turnstile-fake'

// ADR-0025: Turnstile on sign-up, sign-in and the unauthenticated email endpoints, through Better
// Auth's real HTTP handler and captcha plugin. Siteverify answers like Cloudflare does for its test
// secrets (test/turnstile-fake.ts).

const LOGIN_LIMIT = 5

/** POSTs `body` to `path` through a Better Auth instance with `botProtection`. */
function post(
  path: string,
  body: unknown,
  { botProtection = { secretKey: PASS_SECRET }, ip = randomIp(), token = DUMMY_TOKEN } = {} as {
    botProtection?: BotProtection
    ip?: string
    token?: string | null
  },
) {
  return withDb((db) =>
    createAuth({
      db,
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      allowSignUp: () => true,
      requireEmailVerification: true,
      botProtection,
      log: logBetterAuth,
      sendEmail: async () => {},
    }).handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: env.BETTER_AUTH_URL,
          'cf-connecting-ip': ip,
          ...(token && { 'x-captcha-response': token }),
        },
        body: JSON.stringify(body),
      }),
    ),
  )
}

const bodyFor = (path: string, email = `t-${crypto.randomUUID()}@test.local`) =>
  path === '/sign-up/email'
    ? { email, password: PASSWORD, name: 'x' }
    : path === '/sign-in/email'
      ? { email, password: PASSWORD }
      : path === '/request-password-reset'
        ? { email, redirectTo: '/reset-password' }
        : { email }

const userExists = (email: string) =>
  withDb(
    async (db) => !!(await db.query.user.findFirst({ where: (t, { eq }) => eq(t.email, email) })),
  )

afterEach(() => {
  siteverifyOutage.mode = null
  vi.restoreAllMocks()
})

describe('Turnstile on the protected endpoints', () => {
  it.each(BOT_PROTECTED_PATHS)('%s without a token is refused (400)', async (path) => {
    const res = await post(path, bodyFor(path), { token: null })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'MISSING_RESPONSE' })
  })

  it.each(BOT_PROTECTED_PATHS)('%s with a rejected token is refused (403)', async (path) => {
    const res = await post(path, bodyFor(path), { botProtection: { secretKey: FAIL_SECRET } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'VERIFICATION_FAILED' })
  })

  it.each(BOT_PROTECTED_PATHS)('%s with a valid token reaches the endpoint', async (path) => {
    const res = await post(path, bodyFor(path))
    // Sign-in for an unknown address is a 401 from the endpoint itself, past the bot check.
    expect(res.status).toBe(path === '/sign-in/email' ? 401 : 200)
  })

  it('sends the secret, the token and the client IP to siteverify', async () => {
    const ip = randomIp()
    const before = siteverifyCalls.length
    await post('/request-password-reset', bodyFor('/request-password-reset'), { ip })
    expect(siteverifyCalls.slice(before)).toEqual([
      { secret: PASS_SECRET, response: DUMMY_TOKEN, remoteip: ip },
    ])
  })

  it('creates no account when the token is rejected or already spent', async () => {
    for (const secretKey of [FAIL_SECRET, SPENT_SECRET]) {
      const email = `t-${crypto.randomUUID()}@test.local`
      const res = await post('/sign-up/email', bodyFor('/sign-up/email', email), {
        botProtection: { secretKey },
      })
      expect(res.status).toBe(403)
      expect(await userExists(email)).toBe(false)
    }
  })

  it('refuses a token issued for another hostname', async () => {
    // A test key's token reports example.com; production allows only the app's own hostname.
    const res = await post('/sign-up/email', bodyFor('/sign-up/email'), {
      botProtection: { secretKey: PASS_SECRET, allowedHostnames: ['app.example.test'] },
    })
    expect(res.status).toBe(403)
  })

  it.each([503, 'network'] as const)(
    'fails closed when siteverify is down (%s): 500, nothing created, logged',
    async (mode) => {
      siteverifyOutage.mode = mode
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const email = `t-${crypto.randomUUID()}@test.local`
      const res = await post('/sign-up/email', bodyFor('/sign-up/email', email))
      expect(res.status).toBe(500)
      expect(await userExists(email)).toBe(false)
      const events = error.mock.calls.map((c) => JSON.parse(String(c[0])).event)
      expect(events).toContain('auth.captcha_unavailable')
    },
  )

  it('rate limits first: the 6th sign-in from one IP is 429 without calling siteverify', async () => {
    const { email } = await signUp()
    const ip = randomIp()
    const before = siteverifyCalls.length
    const statuses: number[] = []
    for (let i = 0; i <= LOGIN_LIMIT; i++)
      statuses.push(
        (
          await post(
            '/sign-in/email',
            { email, password: PASSWORD },
            { ip, botProtection: { secretKey: FAIL_SECRET } },
          )
        ).status,
      )
    expect(statuses).toEqual([...Array(LOGIN_LIMIT).fill(403), 429])
    expect(siteverifyCalls.length - before).toBe(LOGIN_LIMIT)
  })

  it('refuses (503) test keys bound to another host, accepts them on their own', async () => {
    // A production Worker misconfigured with a preview URL must not take the dummy token on its
    // real domain (the requests here arrive at BETTER_AUTH_URL's host).
    for (const path of BOT_PROTECTED_PATHS) {
      const res = await post(path, bodyFor(path), {
        botProtection: { secretKey: PASS_SECRET, requestHost: 'app.example.com' },
      })
      expect(res.status).toBe(503)
    }
    const own = await post('/sign-up/email', bodyFor('/sign-up/email'), {
      botProtection: { secretKey: PASS_SECRET, requestHost: new URL(env.BETTER_AUTH_URL).host },
    })
    expect(own.status).toBe(200)
  })

  it('leaves other endpoints alone', async () => {
    const res = await withDb((db) =>
      createAuth({
        db,
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.BETTER_AUTH_URL,
        allowSignUp: () => true,
        requireEmailVerification: true,
        botProtection: { secretKey: FAIL_SECRET },
        sendEmail: async () => {},
      }).handler(new Request(`${env.BETTER_AUTH_URL}/api/auth/get-session`)),
    )
    expect(res.status).toBe(200)
  })
})

describe('bot protection unavailable', () => {
  it.each(BOT_PROTECTED_PATHS)('%s is refused (503), even with a token', async (path) => {
    const email = `t-${crypto.randomUUID()}@test.local`
    const res = await post(path, bodyFor(path, email), { botProtection: 'unavailable' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'CAPTCHA_UNAVAILABLE' })
    expect(await userExists(email)).toBe(false)
  })

  it('leaves other endpoints alone', async () => {
    const res = await post('/sign-out', {}, { botProtection: 'unavailable' })
    expect(res.status).not.toBe(503)
  })
})

describe('botProtectionFor (deployment config)', () => {
  const REAL_SECRET = '0x4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const REAL_SITE_KEY = '0x4AAAAAAAAAAAAAAAAAAAAA'
  const warnings = () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    return () => warn.mock.calls.map((c) => JSON.parse(String(c[0])))
  }

  it('uses real keys with the app hostname as the only allowed one', () => {
    expect(botProtectionFor(REAL_SECRET, REAL_SITE_KEY, 'https://app.example.com')).toEqual({
      secretKey: REAL_SECRET,
      allowedHostnames: ['app.example.com'],
    })
  })

  it('accepts test keys only on localhost and workers.dev previews', () => {
    for (const url of ['http://localhost:3000', 'https://pr-1-web.acme.workers.dev'])
      expect(botProtectionFor(PASS_SECRET, PASS_SITE_KEY, url)).toEqual({
        secretKey: PASS_SECRET,
        requestHost: new URL(url).host,
      })
  })

  it('refuses test keys anywhere else (logged)', () => {
    const logged = warnings()
    for (const [secret, site] of [
      [PASS_SECRET, PASS_SITE_KEY],
      [PASS_SECRET, REAL_SITE_KEY],
      [REAL_SECRET, PASS_SITE_KEY],
    ])
      for (const url of [
        'https://app.example.com',
        'https://localhost.example.com',
        'https://x.workers.dev.example.com',
      ])
        expect(botProtectionFor(secret, site, url)).toBe('unavailable')
    expect(logged()).toContainEqual(
      expect.objectContaining({ event: 'auth.turnstile_misconfigured', reason: 'test_key' }),
    )
  })

  it('refuses a missing key everywhere (logged)', () => {
    const logged = warnings()
    for (const url of ['http://localhost:3000', 'https://app.example.com'])
      for (const [secret, site] of [
        [undefined, PASS_SITE_KEY],
        [PASS_SECRET, undefined],
        ['', ''],
      ])
        expect(botProtectionFor(secret, site, url)).toBe('unavailable')
    expect(logged()).toContainEqual(
      expect.objectContaining({ event: 'auth.turnstile_misconfigured', reason: 'missing_key' }),
    )
  })

  it('is what the test environment runs with', () => {
    expect(captchaHeader['x-captcha-response']).toBe(DUMMY_TOKEN)
    const vars = env as unknown as Record<string, string | undefined>
    expect(
      botProtectionFor(vars.TURNSTILE_SECRET_KEY, vars.TURNSTILE_SITE_KEY, env.BETTER_AUTH_URL),
    ).toEqual({ secretKey: PASS_SECRET, requestHost: new URL(env.BETTER_AUTH_URL).host })
  })
})
