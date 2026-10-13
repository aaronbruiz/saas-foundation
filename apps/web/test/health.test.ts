import { describe, expect, inject, it } from 'vitest'
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
    // Expected values come from Node (global-setup.ts): root package.json, HEAD, and the CI run.
    expect(await res.json()).toEqual({ ok: true, db: 'up', ...inject('expectedBuild') })
  })
})
