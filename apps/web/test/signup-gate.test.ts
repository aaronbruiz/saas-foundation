import { env } from 'cloudflare:workers'
import { createAuth } from '@saas-foundation/auth'
import { describe, expect, it } from 'vitest'
import { signUpPolicy } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { rawDb } from '@saas-foundation/db/internal'
import { PASSWORD, randomIp } from './helpers'
import { captchaHeader, testBotProtection } from './turnstile-fake'

// ADR-0014 data gate: until off-provider backups are restore-tested, production admits only
// allowlisted (synthetic) accounts. Unset configuration means closed.

describe('signUpPolicy', () => {
  it('is closed when nothing is configured', () => {
    expect(signUpPolicy(undefined, undefined)('anyone@example.com')).toBe(false)
    expect(signUpPolicy('', '')('anyone@example.com')).toBe(false)
    expect(signUpPolicy('closed', undefined)('anyone@example.com')).toBe(false)
  })

  it('admits exactly the allowlisted addresses, case-insensitively', () => {
    const allow = signUpPolicy(undefined, ' Smoke-1@Example.com, smoke-2@example.com ,')
    expect(allow('smoke-1@example.com')).toBe(true)
    expect(allow('SMOKE-2@EXAMPLE.COM')).toBe(true)
    expect(allow('smoke-3@example.com')).toBe(false)
    expect(allow('example.com')).toBe(false)
  })

  it('admits anyone only with SIGNUP_MODE=open', () => {
    expect(signUpPolicy('open', undefined)('anyone@example.com')).toBe(true)
    expect(signUpPolicy('OPEN', undefined)('anyone@example.com')).toBe(false)
  })
})

describe('sign-up through the real handler with an allowlist', () => {
  const allowed = `smoke-${crypto.randomUUID()}@test.local`
  const sent: string[] = []
  const signUpAs = (email: string, requireEmailVerification = true) =>
    withDb(async (db) => {
      const auth = createAuth({
        db,
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.BETTER_AUTH_URL,
        allowSignUp: signUpPolicy(undefined, allowed),
        requireEmailVerification,
        botProtection: testBotProtection,
        sendEmail: async (e) => {
          sent.push(e.to)
        },
      })
      const res = await auth.handler(
        new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: env.BETTER_AUTH_URL,
            'cf-connecting-ip': randomIp(),
            ...captchaHeader,
          },
          body: JSON.stringify({ email, password: PASSWORD, name: 'x' }),
        }),
      )
      const exists = await rawDb(db).query.user.findFirst({
        where: (u, { eq }) => eq(u.email, email),
      })
      return { status: res.status, exists: Boolean(exists) }
    })

  it('refuses an address outside the allowlist (403) and creates no user', async () => {
    await expect(signUpAs(`real-${crypto.randomUUID()}@test.local`, false)).resolves.toEqual({
      status: 403,
      exists: false,
    })
  })

  // ADR-0016: with verification required, Better Auth answers a refused sign-up like any other
  // ("check your email"), so the allowlist can't be probed; no user is created and nothing is sent.
  it('answers a refused address like any sign-up when verification is required', async () => {
    const email = `real-${crypto.randomUUID()}@test.local`
    await expect(signUpAs(email)).resolves.toEqual({ status: 200, exists: false })
    expect(sent).not.toContain(email)
  })

  it('accepts an allowlisted address', async () => {
    await expect(signUpAs(allowed)).resolves.toEqual({ status: 200, exists: true })
  })
})
