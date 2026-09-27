import { env } from 'cloudflare:workers'
import { createDb, currentDatabase } from '@saas-foundation/db'
import { describe, expect, it } from 'vitest'

// Tests must never touch local dev data: vitest.config.ts points DB at `app_test`.
describe('test database isolation', () => {
  it('connects to app_test, not the dev database', async () => {
    const { db, close } = await createDb(env.DB.connectionString)
    try {
      await expect(currentDatabase(db)).resolves.toBe('app_test')
    } finally {
      await close()
    }
  })
})
