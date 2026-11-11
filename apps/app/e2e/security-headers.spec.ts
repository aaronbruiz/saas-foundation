import type { APIResponse } from '@playwright/test'
import { STYLE_ATTR_HASHES, STYLE_ELEM_HASHES } from '../src/server/csp-hashes.gen'
import { expect, test } from './fixtures'

// ADR-0045: the Worker's entry (src/server.ts) sets these on every response Start produces.
function expectSecurityHeaders(res: APIResponse) {
  const h = res.headers()
  expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' /)
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(h['strict-transport-security']).toBe('max-age=31536000')
  expect(h['x-content-type-options']).toBe('nosniff')
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(h['x-frame-options']).toBe('DENY')
}

const nonceOf = (res: APIResponse) =>
  /'nonce-([^']+)'/.exec(res.headers()['content-security-policy'] ?? '')?.[1]

test("an SSR page carries the security headers, and its scripts carry that response's nonce", async ({
  request,
}) => {
  const res = await request.get('/login')
  expect(res.status()).toBe(200)
  expectSecurityHeaders(res)
  const nonce = nonceOf(res)!
  const html = await res.text()
  const scripts = html.match(/<script\b[^>]*>/g) ?? []
  expect(scripts.length).toBeGreaterThan(0)
  for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`)
  expect(nonceOf(await request.get('/login'))).not.toBe(nonce)
})

test('the ping route keeps its answer and carries the security headers', async ({ request }) => {
  const res = await request.get('/api/ping')
  expect(res.status()).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true })
  expectSecurityHeaders(res)
})

test('the health route keeps its answer and carries the security headers', async ({ request }) => {
  const res = await request.get('/api/health')
  expect([200, 503]).toContain(res.status())
  expect(await res.json()).toHaveProperty('ok')
  expectSecurityHeaders(res)
})

test("a server function's 404 and the cross-origin 403 carry the security headers", async ({
  request,
  baseURL,
}) => {
  const unknown = await request.post('/_serverFn/does-not-exist', {
    headers: { origin: new URL(baseURL!).origin, 'x-tsr-serverFn': 'true' },
    data: {},
  })
  expect(unknown.status()).toBe(404)
  expectSecurityHeaders(unknown)
  const crossOrigin = await request.post('/_serverFn/does-not-exist', {
    headers: { origin: 'https://evil.example', 'x-tsr-serverFn': 'true' },
    data: {},
  })
  expect(crossOrigin.status()).toBe(403)
  expectSecurityHeaders(crossOrigin)
})

test('the sign-in page hydrates and loads Turnstile without a CSP violation', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = []
    Object.assign(window, { __cspViolations: seen })
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI}`),
    )
  })
  // The client router reads the nonce back from the page; without it, React reports a mismatch.
  const hydrationErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && /hydrat/i.test(m.text())) hydrationErrors.push(m.text())
  })
  await page.goto('/login')
  // The button stays disabled until the page hydrates (its nonced scripts) and Turnstile returns a
  // token (its script and iframe); a cold dev server takes longer than expect's default 5 s.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled({ timeout: 30_000 })
  expect(
    await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations),
  ).toEqual([])
  expect(hydrationErrors).toEqual([])
})

test('the CSP keeps style-src self and allows only the generated style hashes', async ({
  request,
}) => {
  const csp = (await request.get('/login')).headers()['content-security-policy'] ?? ''
  const directives = Object.fromEntries(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name, values]
    }),
  )
  expect(directives['style-src']).toEqual(["'self'"])
  expect(directives['style-src-elem']).toEqual(["'self'", ...STYLE_ELEM_HASHES])
  expect(directives['style-src-attr']).toEqual(["'unsafe-hashes'", ...STYLE_ATTR_HASHES])
  // ADR-0045 as amended: exactly sonner's two <style> contents and Base UI's two hidden-input styles.
  expect(STYLE_ELEM_HASHES).toHaveLength(2)
  expect(STYLE_ATTR_HASHES).toHaveLength(2)
  expect(csp).not.toContain('unsafe-inline')
})
