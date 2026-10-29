import { describe, expect, inject, it, vi } from 'vitest'

// An uptime monitor polls this every few minutes; touching the database would keep Neon awake
// around the clock (ADR-0031 "Alternatives"), so opening a connection fails this test. It covers the
// handler only: the global middleware (start.ts) can't load in the workerd pool; a full-path probe
// with the database unreachable (2026-10-29) answered 200 here and 503 on /api/health.
vi.mock('@saas-foundation/db', () => ({
  createDb: () => {
    throw new Error('ping opened a database connection')
  },
}))
const { pingResponse } = await import('../src/server/ping')

describe('GET /api/ping', () => {
  it('answers 200 with the build it runs, and its handler never opens a database connection', async () => {
    const res = pingResponse()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, ...inject('expectedBuild') })
  })
})
