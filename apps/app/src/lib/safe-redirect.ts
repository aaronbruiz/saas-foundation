const BASE = 'http://same-origin.invalid'

/**
 * Post-login target limited to same-site paths. Parsed against a fixed base (never string
 * matched): "//host", "/\host" (browsers treat "\" as "/"), and absolute or scheme URLs resolve
 * to a different origin and fall back. Returns only path, query and hash.
 */
export function safeRedirect(target: unknown, fallback = '/'): string {
  if (typeof target !== 'string' || !target.startsWith('/')) return fallback
  try {
    const url = new URL(target, BASE)
    return url.origin === BASE ? url.pathname + url.search + url.hash : fallback
  } catch {
    return fallback
  }
}

/**
 * Where a verification link lands (ADR-0016): the sign-in page, saying the address is verified,
 * then on to `target` (itself limited to same-site paths). Built with URLSearchParams, never by
 * string concatenation.
 */
export function verifiedLoginUrl(target: unknown): string {
  return `/login?${new URLSearchParams({ verified: '1', redirect: safeRedirect(target) })}`
}
