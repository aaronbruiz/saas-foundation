/**
 * Turnstile in tests (ADR-0025). Bot protection is never switched off for tests: requests carry
 * Cloudflare's documented dummy token and the app verifies it with the always-pass test secret,
 * through Better Auth's real captcha plugin. Only the siteverify HTTP call is answered locally, the
 * way Cloudflare answers it for its test secrets (responses captured 2026-10-01), so no test needs
 * the network.
 */
export const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** What a test site key's widget produces. */
export const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
export const PASS_SECRET = '1x0000000000000000000000000000000AA'
export const FAIL_SECRET = '2x0000000000000000000000000000000AA'
export const SPENT_SECRET = '3x0000000000000000000000000000000AA'
export const PASS_SITE_KEY = '1x00000000000000000000AA'

export const captchaHeader = { 'x-captcha-response': DUMMY_TOKEN }
/** `createAuth`'s botProtection for tests that build their own auth instance. */
export const testBotProtection = { secretKey: PASS_SECRET }

/** Every siteverify request the fake answered (body as sent), for assertions. */
export const siteverifyCalls: Record<string, unknown>[] = []
/** Set to make siteverify fail: an HTTP status, or `'network'` for a connection error. */
export const siteverifyOutage: { mode: number | 'network' | null } = { mode: null }

const testing = { metadata: { result_with_testing_key: true } }

async function answer(request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>
  siteverifyCalls.push(body)
  if (siteverifyOutage.mode === 'network') throw new TypeError('Network connection lost.')
  if (siteverifyOutage.mode) return new Response('unavailable', { status: siteverifyOutage.mode })
  const fail = (code: string) =>
    Response.json({ success: false, 'error-codes': [code], messages: [], ...testing })
  if (body.secret === PASS_SECRET)
    return Response.json({
      success: true,
      challenge_ts: new Date().toISOString(),
      hostname: 'example.com',
      'error-codes': [],
      ...testing,
    })
  if (body.secret === FAIL_SECRET) return fail('invalid-input-response')
  if (body.secret === SPENT_SECRET) return fail('timeout-or-duplicate')
  return fail('invalid-input-secret')
}

/** Wraps a fetch so siteverify goes to the fake and everything else to `next`. */
export function withSiteverify(next: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    if (request.url === SITEVERIFY) return answer(request)
    return next(input, init)
  }
}
