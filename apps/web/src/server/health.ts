import { env } from 'cloudflare:workers'
import { createDb, ping } from '@saas-foundation/db'
import { logError } from './log'

// Replaced at build time by Vite `define` (vite.config.ts, from build-info.ts; ADR-0029 decision 4).
declare const __BUILD_INFO__: { version: string; commit: string; build: string }

/** Proves Worker → Hyperdrive (`DB`) → Postgres connectivity with one round trip. */
export async function checkDatabase(): Promise<boolean> {
  const { db, close } = await createDb(env.DB.connectionString)
  try {
    return await ping(db)
  } finally {
    await close()
  }
}

/**
 * `GET /api/health`: `{ ok, db, version, commit, build }`, 503 when the database is down. `build`
 * tells uploads of the same version apart (the release smoke test checks it, ADR-0029).
 */
export async function healthResponse(rayId?: string): Promise<Response> {
  const db = await checkDatabase().catch((e: unknown) => {
    logError('health.db_down', e, { rayId })
    return false
  })
  return Response.json(
    { ok: db, db: db ? 'up' : 'down', ...__BUILD_INFO__ },
    { status: db ? 200 : 503 },
  )
}
