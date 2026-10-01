import { env } from 'cloudflare:workers'
import { createAuth, type AuthEmail } from '@saas-foundation/auth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mailerFor, render, type EmailMessage } from '../src/server/email'
import { withDb } from '../src/server/db'
import { emailVerificationRequired } from '../src/server/auth'
import { PASSWORD, randomIp } from './helpers'
import { captchaHeader, testBotProtection } from './turnstile-fake'

// ADR-0016: auth emails behind one mailer seam; tokens travel in query strings (ADR-0015).
afterEach(() => vi.restoreAllMocks())

const inviteUrl = (id: string) => `https://app.test/invite/${id}`

describe('render', () => {
  it('escapes user-controlled text in HTML and includes the link in both parts', () => {
    const m = render(
      {
        kind: 'invitation',
        to: 'x@test.local',
        invitationId: 'inv1',
        organizationName: '<b>Evil</b>',
      },
      inviteUrl,
    )
    expect(m.html).toContain('&#60;b&#62;Evil&#60;/b&#62;')
    expect(m.html).not.toContain('<b>Evil</b>')
    expect(m.text).toContain('https://app.test/invite/inv1')
    expect(m.html).toContain('href="https://app.test/invite/inv1"')
  })

  it('renders reset and verification emails around their URL', () => {
    const reset = render(
      { kind: 'password-reset', to: 'x@test.local', url: 'https://a/r?token=t' },
      inviteUrl,
    )
    expect(reset).toMatchObject({ to: 'x@test.local', subject: 'Reset your password' })
    expect(reset.text).toContain('https://a/r?token=t')
    const verify = render(
      { kind: 'verification', to: 'x@test.local', url: 'https://a/v?token=t' },
      inviteUrl,
    )
    expect(verify.subject).toBe('Verify your email address')
  })
})

describe('mailerFor', () => {
  const msg: EmailMessage = {
    kind: 'invitation',
    to: 'secret-person@test.local',
    subject: 'Invited to Secret Org',
    text: 't',
    html: 'h',
  }

  it('is disabled by default: sends nothing, logs a warning without the address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mailerFor({ BETTER_AUTH_URL: 'https://app.test' })(msg)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('email.delivery_disabled')
    expect(String(warn.mock.calls[0]![0])).not.toContain('secret-person')
    expect(String(warn.mock.calls[0]![0])).not.toContain('Secret Org')
    expect(String(warn.mock.calls[0]![0])).toContain('"kind":"invitation"')
  })

  it('refuses console delivery outside localhost', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await expect(
      mailerFor({ EMAIL_DELIVERY: 'console', BETTER_AUTH_URL: 'https://app.test' })(msg),
    ).rejects.toThrow(/only allowed on localhost/)
    expect(info).not.toHaveBeenCalled()
  })

  it('refuses console delivery in a non-dev build, even on localhost', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await expect(
      mailerFor(
        { EMAIL_DELIVERY: 'console', BETTER_AUTH_URL: 'http://localhost:3000' },
        false,
      )(msg),
    ).rejects.toThrow(/only allowed on localhost/)
    expect(info).not.toHaveBeenCalled()
  })

  it('needs the binding and a sender for Cloudflare delivery', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      mailerFor({ EMAIL_DELIVERY: 'cloudflare', BETTER_AUTH_URL: 'https://app.test' })(msg),
    ).rejects.toThrow(/EMAIL binding and EMAIL_FROM/)
  })

  it('sends through the Cloudflare binding', async () => {
    const send = vi.fn(async () => ({ messageId: 'm1' }))
    await mailerFor({
      EMAIL_DELIVERY: 'cloudflare',
      EMAIL_FROM: 'no-reply@app.test',
      BETTER_AUTH_URL: 'https://app.test',
      EMAIL: { send },
    })(msg)
    expect(send).toHaveBeenCalledWith({
      to: 'secret-person@test.local',
      from: { email: 'no-reply@app.test', name: 'SaaS Foundation' },
      subject: 'Invited to Secret Org',
      text: 't',
      html: 'h',
    })
  })
})

describe('emailVerificationRequired', () => {
  const preview = 'https://pr-12-saas-foundation-preview.example.workers.dev'

  it('is on unless set to exactly "off"', () => {
    for (const v of [undefined, '', 'on', 'OFF', 'false', '0', ' off'])
      expect(emailVerificationRequired(v, preview)).toBe(true)
  })

  it('honours "off" only on a workers.dev preview URL', () => {
    expect(emailVerificationRequired('off', preview)).toBe(false)
  })

  it('refuses "off" anywhere else, and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const url of [
      'https://app.aaronlabr.dev',
      'http://localhost:3000',
      'http://x.workers.dev',
      'https://x.workers.dev.evil.test',
      'https://x.workers.dev/path',
    ])
      expect(emailVerificationRequired('off', url)).toBe(true)
    expect(String(warn.mock.calls[0]![0])).toContain('auth.email_verification_off_refused')
  })
})

describe('auth email flows through the real handler', () => {
  const sent: AuthEmail[] = []
  const call = (path: string, init: RequestInit = {}, requireEmailVerification = true) =>
    withDb((db) =>
      createAuth({
        db,
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.BETTER_AUTH_URL,
        allowSignUp: () => true,
        requireEmailVerification,
        botProtection: testBotProtection,
        sendEmail: async (e) => {
          sent.push(e)
        },
      }).handler(
        new Request(path.startsWith('http') ? path : `${env.BETTER_AUTH_URL}/api/auth${path}`, {
          ...init,
          headers: {
            'content-type': 'application/json',
            origin: env.BETTER_AUTH_URL,
            'cf-connecting-ip': randomIp(),
            ...captchaHeader,
            ...(init.headers as Record<string, string>),
          },
        }),
      ),
    )
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', body: JSON.stringify(body), headers })
  const lastTo = async (to: string, kind: AuthEmail['kind']) => {
    for (let i = 0; i < 20; i++) {
      const hit = [...sent].reverse().find((e) => e.to === to && e.kind === kind)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`no ${kind} email to ${to}`)
  }
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
  const sessionUser = async (cookie: string) =>
    (
      (await (await call('/get-session', { headers: { cookie } })).json()) as {
        user?: { emailVerified: boolean }
      } | null
    )?.user ?? null

  const verificationTo = async (email: string) => {
    const mail = await lastTo(email, 'verification')
    if (mail.kind !== 'verification') throw new Error('unreachable')
    return mail.url
  }
  /** Signs up, follows the emailed link and signs in (ADR-0016); returns the session cookie. */
  const verifiedSession = async (email: string) => {
    expect((await post('/sign-up/email', { email, password: PASSWORD, name: 'x' })).status).toBe(
      200,
    )
    expect((await call(await verificationTo(email), { redirect: 'manual' })).status).toBeLessThan(
      400,
    )
    const res = await post('/sign-in/email', { email, password: PASSWORD })
    expect(res.status).toBe(200)
    return cookieOf(res)
  }

  it('requires a verified address: no session at sign-up, sign-in refused and resent', async () => {
    const email = `v-${crypto.randomUUID()}@test.local`
    const res = await post('/sign-up/email', { email, password: PASSWORD, name: 'v' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { token: string | null }).token).toBeNull()
    expect(cookieOf(res)).not.toContain('session_token')
    const first = await verificationTo(email)
    expect(first).toMatch(/\/api\/auth\/verify-email\?token=/)

    // The right password, unverified: refused, and a fresh link goes out.
    sent.length = 0
    const refused = await post('/sign-in/email', { email, password: PASSWORD })
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { code: string }).code).toBe('EMAIL_NOT_VERIFIED')
    expect(cookieOf(refused)).not.toContain('session_token')
    const resent = await verificationTo(email)

    // A wrong password sends nothing.
    sent.length = 0
    expect((await post('/sign-in/email', { email, password: 'wrong-password-123' })).status).toBe(
      401,
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(sent.filter((e) => e.to === email)).toEqual([])

    // Following the link verifies the address but signs nobody in.
    const verified = await call(resent, { redirect: 'manual' })
    expect(verified.status).toBeLessThan(400)
    expect(cookieOf(verified)).not.toContain('session_token')
    const ok = await post('/sign-in/email', { email, password: PASSWORD })
    expect(ok.status).toBe(200)
    expect((await sessionUser(cookieOf(ok)))?.emailVerified).toBe(true)
  })

  it('refuses invitation acceptance by an unverified session', async () => {
    const owner = await verifiedSession(`o-${crypto.randomUUID()}@test.local`)
    const slug = `ver-${crypto.randomUUID().slice(0, 8)}`
    const org = (await (
      await post('/organization/create', { name: 'Ver Org', slug }, { cookie: owner })
    ).json()) as { id: string }
    // A session created before verification was enforced (as on existing deployments).
    const invitee = `i-${crypto.randomUUID()}@test.local`
    const legacy = await call(
      '/sign-up/email',
      { method: 'POST', body: JSON.stringify({ email: invitee, password: PASSWORD, name: 'i' }) },
      false,
    )
    const cookie = cookieOf(legacy)
    expect(cookie).toContain('session_token')
    const inv = (await (
      await post(
        '/organization/invite-member',
        { email: invitee, role: 'member', organizationId: org.id },
        { cookie: owner },
      )
    ).json()) as { id: string }
    const res = await post('/organization/accept-invitation', { invitationId: inv.id }, { cookie })
    expect(res.status).toBe(403)
    // Once verified, the same session can accept.
    await call(await verificationTo(invitee), { redirect: 'manual' })
    expect(
      (await post('/organization/accept-invitation', { invitationId: inv.id }, { cookie })).status,
    ).toBe(200)
  })

  it('resets a password via a query-string token and revokes existing sessions', async () => {
    const email = `r-${crypto.randomUUID()}@test.local`
    const old = await verifiedSession(email)
    expect(await sessionUser(old)).not.toBeNull()

    expect(
      (await post('/request-password-reset', { email, redirectTo: '/reset-password' })).status,
    ).toBe(200)
    const mail = await lastTo(email, 'password-reset')
    if (mail.kind !== 'password-reset') throw new Error('unreachable')
    const url = new URL(mail.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${env.BETTER_AUTH_URL}/reset-password`)
    const token = url.searchParams.get('token')!
    expect(token).toBeTruthy()

    const next = 'another-correct-horse-battery'
    expect((await post('/reset-password', { newPassword: next, token })).status).toBe(200)
    expect(await sessionUser(old)).toBeNull()
    expect((await post('/sign-in/email', { email, password: PASSWORD })).status).toBe(401)
    expect((await post('/sign-in/email', { email, password: next })).status).toBe(200)
    // Single use.
    expect(
      (await post('/reset-password', { newPassword: 'third-password-123', token })).status,
    ).toBe(400)
  })

  it('sends reset emails in the background when a runner is given (no timing oracle)', async () => {
    const email = `t-${crypto.randomUUID()}@test.local`
    expect((await post('/sign-up/email', { email, password: PASSWORD, name: 't' })).status).toBe(
      200,
    )
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const background: Promise<unknown>[] = []
    const res = await withDb((db) =>
      createAuth({
        db,
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.BETTER_AUTH_URL,
        allowSignUp: () => true,
        requireEmailVerification: true,
        botProtection: testBotProtection,
        sendEmail: () => gate, // a provider that hasn't answered yet
        runInBackground: (p) => void background.push(p),
      }).handler(
        new Request(`${env.BETTER_AUTH_URL}/api/auth/request-password-reset`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: env.BETTER_AUTH_URL,
            'cf-connecting-ip': randomIp(),
            ...captchaHeader,
          },
          body: JSON.stringify({ email, redirectTo: '/reset-password' }),
        }),
      ),
    )
    // The response came back while the send is still pending.
    expect(res.status).toBe(200)
    expect(background.length).toBeGreaterThan(0)
    release()
    await Promise.all(background)
  })

  it('does not reveal whether an account exists', async () => {
    const res = await post('/request-password-reset', {
      email: `nobody-${crypto.randomUUID()}@test.local`,
      redirectTo: '/reset-password',
    })
    expect(res.status).toBe(200)
  })

  it('sends an invitation email with the organization name', async () => {
    const owner = `o-${crypto.randomUUID()}@test.local`
    const cookie = await verifiedSession(owner)
    const slug = `mail-${crypto.randomUUID().slice(0, 8)}`
    const org = (await (
      await post('/organization/create', { name: 'Mail Org', slug }, { cookie })
    ).json()) as { id: string }
    const invitee = `i-${crypto.randomUUID()}@test.local`
    const res = await post(
      '/organization/invite-member',
      { email: invitee, role: 'member', organizationId: org.id },
      { cookie },
    )
    expect(res.status).toBe(200)
    await expect(lastTo(invitee, 'invitation')).resolves.toMatchObject({
      kind: 'invitation',
      organizationName: 'Mail Org',
    })
  })
})
