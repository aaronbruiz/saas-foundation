import { env } from 'cloudflare:workers'
import { createDb, type Db } from '@saas-foundation/db'

/** One pg client per request through the uncached `DB` Hyperdrive binding (ADR-0003/0004). */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(env.DB.connectionString)
  try {
    return await fn(db)
  } finally {
    await close()
  }
}
