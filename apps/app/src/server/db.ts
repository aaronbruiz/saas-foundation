import { env } from 'cloudflare:workers'
import { createDb, isDeletedAccountViolation, type Db } from '@saas-foundation/db'
import { HttpError } from './errors'

/** One pg client per request through the uncached `DB` Hyperdrive binding (ADR-0003/0004). */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(env.DB.connectionString)
  try {
    return await fn(db)
  } catch (e) {
    // A write for an account deactivated since this request authenticated (ADR-0044).
    if (isDeletedAccountViolation(e)) throw new HttpError(401, 'unauthorized')
    throw e
  } finally {
    await close()
  }
}
