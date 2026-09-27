import { env } from 'cloudflare:workers'
import { createDb, ping } from '@saas-foundation/db'

/** Proves Worker → Hyperdrive (`DB`) → Postgres connectivity with one round trip. */
export async function checkDatabase(): Promise<boolean> {
  const { db, close } = await createDb(env.DB.connectionString)
  try {
    return await ping(db)
  } finally {
    await close()
  }
}
