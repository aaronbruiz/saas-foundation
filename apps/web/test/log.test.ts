import { afterEach, describe, expect, it, vi } from 'vitest'
import { APIError } from 'better-auth/api'
import { HttpError } from '../src/server/errors'
import { logBetterAuth, logError, logUnexpected, redact } from '../src/server/log'

// Observability baseline (ADR-0015): structured, PII-free error logs; only unexpected errors.
afterEach(() => vi.restoreAllMocks())

const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)

describe('logError', () => {
  it('writes one JSON line with event, fields and the error name/message/code', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('boom'), { code: '57P01', detail: 'Key (email)=(a@b.co)' })
    logError('test.event', err, { rayId: 'abc123-IAD' })
    expect(lines(spy)).toEqual([
      {
        level: 'error',
        event: 'test.event',
        rayId: 'abc123-IAD',
        error: { name: 'Error', message: 'boom', code: '57P01' },
      },
    ])
    // Driver details (which can hold row values) are never copied.
    expect(String(spy.mock.calls[0]![0])).not.toContain('a@b.co')
  })

  it('redacts emails and URL credentials inside messages', () => {
    expect(redact('user alice@example.com failed')).toBe('user [email] failed')
    expect(redact('connect postgres://app_owner:s3cr3t@host/db failed')).toBe(
      'connect postgres://[redacted]@host/db failed',
    )
  })

  it('redacts auth headers, secret key/value pairs, query strings and long opaque tokens', () => {
    // Over-redaction is fine: the scheme name goes too.
    expect(redact('Authorization: Bearer abc.def.ghi rejected')).toBe(
      'Authorization: [redacted] [redacted] rejected',
    )
    expect(redact('sent Bearer abc.def.ghi')).toBe('sent Bearer [redacted]')
    expect(redact('bad password=hunter2; token: t0k3n')).toBe(
      'bad password=[redacted]; token: [redacted]',
    )
    expect(redact('GET /api/auth/reset?token=xyz&email=a%40b.co failed')).toBe(
      'GET /api/auth/reset?[redacted] failed',
    )
    expect(redact('invalid key sk_live_0123456789abcdefghijklmnopqrstuv')).toBe(
      'invalid key [redacted]',
    )
  })

  it('redacts compound and camelCase secret keys, even with short values', () => {
    expect(redact('client_secret=ab access_token=cd refreshToken: ef x-api-key=gh')).toBe(
      'client_secret=[redacted] access_token=[redacted] refreshToken: [redacted] x-api-key=[redacted]',
    )
  })

  it('redacts quoted values and JSON-style quoted keys', () => {
    expect(redact('token="abc def" and pwd=\'x\'')).toBe(
      'token="[redacted]" and pwd=\'[redacted]\'',
    )
    expect(redact('{"access_token":"abc","user":"u1"}')).toBe(
      '{"access_token":"[redacted]","user":"u1"}',
    )
  })

  it('redacts error name and string code too', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('x'), { code: 'user eve@example.com' })
    err.name = 'Err token=abc'
    logError('e', err)
    expect(lines(spy)[0]!.error).toEqual({
      name: 'Err token=[redacted]',
      message: 'x',
      code: 'user [email]',
    })
  })

  it('truncates long messages and stays fast on adversarial input', () => {
    expect(redact('x'.repeat(10_000)).length).toBeLessThanOrEqual(300)
    const start = Date.now()
    redact(('a'.repeat(50) + '@').repeat(200))
    redact('postgres://' + ':'.repeat(5000))
    expect(Date.now() - start).toBeLessThan(200)
  })
})

// serve() (server/boundary.ts) delegates to logUnexpected; boundary itself needs TanStack's
// request context, which the workerd test pool doesn't provide.
describe('logUnexpected', () => {
  it('logs unexpected errors with the event name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(logUnexpected('server_fn.unhandled', new Error('db exploded for bob@example.com'))).toBe(
      true,
    )
    expect(lines(spy)).toMatchObject([
      {
        event: 'server_fn.unhandled',
        error: { name: 'Error', message: 'db exploded for [email]' },
      },
    ])
  })

  it('does not log expected client errors (HttpError, Better Auth 4xx)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const e of [
      new HttpError(403, 'forbidden'),
      new HttpError(409, 'conflict'),
      new APIError('BAD_REQUEST'),
    ])
      expect(logUnexpected('server_fn.unhandled', e)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('logs library errors whose status is not 4xx', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const statusCode of [0, 200, 302, 399, 500])
      expect(logUnexpected('x', Object.assign(new Error('odd'), { statusCode }))).toBe(true)
  })

  it('logs server-side library errors (5xx)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(logUnexpected('x', new APIError('INTERNAL_SERVER_ERROR'))).toBe(true)
  })
})

describe('logBetterAuth', () => {
  it('accepts Error and non-string messages without throwing, redacted', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logBetterAuth('error', new Error('session failed for dan@example.com'))
    logBetterAuth('error', { any: 'thing' })
    logBetterAuth('error', 'plain token=abc')
    expect(lines(spy).map((l) => l.message)).toEqual([
      'Error: session failed for [email]',
      'non-string log message (object)',
      'plain token=[redacted]',
    ])
  })
})
