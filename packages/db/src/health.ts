import { sql } from 'drizzle-orm'
import { rawDb, type Db } from './client.ts'

/** Round-trips a trivial query. Used by the health endpoint to prove DB connectivity. */
export async function ping(db: Db): Promise<boolean> {
  const result = await rawDb(db).execute<{ ok: number }>(sql`select 1 as ok`)
  return result.rows[0]?.ok === 1
}

/** Name of the connected database. Lets tests assert they run against `app_test`. */
export async function currentDatabase(db: Db): Promise<string | undefined> {
  const result = await rawDb(db).execute<{ name: string }>(sql`select current_database() as name`)
  return result.rows[0]?.name
}
