import { describe, expect, it } from 'vitest'
import { checkDatabase, healthResponse } from '../src/server/health'

// Phase 0 spike V3: the Hyperdrive binding works inside the Vitest Workers runtime.
describe('database connectivity', () => {
  it('reaches Postgres through the DB (Hyperdrive) binding', async () => {
    await expect(checkDatabase()).resolves.toBe(true)
  })
})

// ADR-0029 decision 4: the release smoke test reads these fields; previews only check `ok`.
describe('GET /api/health', () => {
  it('reports the database up and the version, commit and build it was built from', async () => {
    const res = await healthResponse()
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, db: 'up' })
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(body.commit).toMatch(/^([0-9a-f]{7}|unknown)$/)
    expect(body.build).toMatch(/^(\d+-\d+|local)$/)
  })
})
