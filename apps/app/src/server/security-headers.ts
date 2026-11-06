// ADR-0045: security headers on every response the Worker produces. Scripts run only from this
// origin, Turnstile's (ADR-0025) or with the request's nonce, which TanStack Start puts on its own
// tags (`ssr.nonce` in router.tsx). Applied in the Worker's entry, src/server.ts. A new third-party origin is added here in the same PR.

const TURNSTILE = 'https://challenges.cloudflare.com'

/** 128 random bits, base64: a new one for every request. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
}

export function contentSecurityPolicy(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${TURNSTILE}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    // Vite's dev client talks to its server over a WebSocket on the same host.
    dev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
    `frame-src ${TURNSTILE}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Adds the headers; a response whose headers are immutable (`Response.redirect`) is copied first. */
export function withSecurityHeaders(response: Response, nonce: string, dev = false): Response {
  try {
    setSecurityHeaders(response.headers, nonce, dev)
    return response
  } catch {
    const copy = new Response(response.body, response)
    setSecurityHeaders(copy.headers, nonce, dev)
    return copy
  }
}

function setSecurityHeaders(headers: Headers, nonce: string, dev: boolean): void {
  headers.set('Content-Security-Policy', contentSecurityPolicy(nonce, dev))
  headers.set('Strict-Transport-Security', 'max-age=31536000')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('X-Frame-Options', 'DENY')
}
