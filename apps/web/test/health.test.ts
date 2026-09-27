import { describe, expect, it } from 'vitest'
import { checkDatabase } from '../src/server/health'

// Phase 0 spike V3: the Hyperdrive binding works inside the Vitest Workers runtime.
describe('database connectivity', () => {
  it('reaches Postgres through the DB (Hyperdrive) binding', async () => {
    await expect(checkDatabase()).resolves.toBe(true)
  })
})
