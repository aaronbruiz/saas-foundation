import { afterEach, describe, expect, it, vi } from 'vitest'
import { APIError } from 'better-auth/api'
import { HttpError } from '../src/server/errors'
import { logError, logUnexpected, redact } from '../src/server/log'

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

  it('logs server-side library errors (5xx)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(logUnexpected('x', new APIError('INTERNAL_SERVER_ERROR'))).toBe(true)
  })
})
