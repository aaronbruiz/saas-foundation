import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Client } from 'pg'
import * as schema from './schema/index.ts'

export type Db = NodePgDatabase<typeof schema>

/**
 * Opens a connection for one request. On Workers, pass `env.DB.connectionString` (Hyperdrive)
 * and call `close()` when done (e.g. via `ctx.waitUntil`). Never share a client across requests.
 */
export async function createDb(
  connectionString: string,
): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new Client({ connectionString })
  await client.connect()
  return { db: drizzle(client, { schema }), close: () => client.end() }
}
