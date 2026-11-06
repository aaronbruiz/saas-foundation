import { describe, expect, it } from 'vitest'
import {
  contentSecurityPolicy,
  newNonce,
  withSecurityHeaders,
} from '../src/server/security-headers'

// ADR-0045. The Worker entry (src/server.ts) needs Start's virtual modules, so e2e checks it on real
// responses (e2e/security-headers.spec.ts).
describe('security headers', () => {
  it('a nonce is 128 random bits and differs on every request', () => {
    const a = newNonce()
    expect(atob(a)).toHaveLength(16)
    expect(newNonce()).not.toBe(a)
  })

  it('the CSP allows scripts only from the app, Turnstile or the nonce, and forbids framing', () => {
    const csp = contentSecurityPolicy('abc')
    expect(csp).toContain("script-src 'self' 'nonce-abc' https://challenges.cloudflare.com;")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("connect-src 'self';")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('ws:')
  })

  it("only the dev server's policy allows Vite's WebSocket", () => {
    expect(contentSecurityPolicy('abc', true)).toContain("connect-src 'self' ws: wss:")
  })

  it('sets HSTS for a year without subdomains, nosniff, the referrer policy and no framing', () => {
    const res = new Response('ok', { status: 201, headers: { 'cache-control': 'no-store' } })
    const out = withSecurityHeaders(res, 'abc')
    expect(out).toBe(res)
    const h = out.headers
    expect(h.get('content-security-policy')).toBe(contentSecurityPolicy('abc'))
    expect(h.get('strict-transport-security')).toBe('max-age=31536000')
    expect(h.get('x-content-type-options')).toBe('nosniff')
    expect(h.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(h.get('x-frame-options')).toBe('DENY')
    expect(h.get('cache-control')).toBe('no-store')
  })

  it('a redirect with immutable headers keeps its status and location and gains the headers', () => {
    const redirect = Response.redirect('https://app.test/login', 302)
    const out = withSecurityHeaders(redirect, 'abc')
    expect(out.status).toBe(302)
    expect(out.headers.get('location')).toBe('https://app.test/login')
    expect(out.headers.get('content-security-policy')).toBe(contentSecurityPolicy('abc'))
  })
})
