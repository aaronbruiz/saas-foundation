import { describe, expect, inject, it, vi } from 'vitest'

// An uptime monitor polls this every few minutes; touching the database would keep Neon awake
// around the clock (ADR-0031 "Alternatives"), so opening a connection fails this test.
vi.mock('@saas-foundation/db', () => ({
  createDb: () => {
    throw new Error('ping opened a database connection')
  },
}))
const { pingResponse } = await import('../src/server/ping')

describe('GET /api/ping', () => {
  it('answers 200 with the build it runs, without touching the database', async () => {
    const res = pingResponse()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, ...inject('expectedBuild') })
  })
})
