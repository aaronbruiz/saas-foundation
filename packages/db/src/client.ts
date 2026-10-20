import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { GuardedClient } from './connection.ts'
import * as schema from './schema/index.ts'

/** The Drizzle client. Only this package's repositories, packages/auth and tests use it. */
export type RawDb = NodePgDatabase<typeof schema>

declare const opaque: unique symbol

/**
 * A database handle that can't query anything itself: only repository functions in this package
 * can (AGENTS.md invariant 2). The client sits in a module-private map, not on the object.
 */
export type Db = { readonly [opaque]: true }

const clients = new WeakMap<Db, RawDb>()

export function asDb(raw: RawDb): Db {
  const db = Object.freeze({}) as Db
  clients.set(db, raw)
  return db
}

export function rawDb(db: Db): RawDb {
  const raw = clients.get(db)
  if (!raw) throw new Error('not a Db from @saas-foundation/db')
  return raw
}

/**
 * Opens a connection for one request. On Workers, pass `env.DB.connectionString` (Hyperdrive)
 * and call `close()` when done (e.g. via `ctx.waitUntil`). Never share a client across requests.
 */
export async function createDb(
  connectionString: string,
): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new GuardedClient({ connectionString })
  await client.connect()
  return { db: asDb(drizzle(client, { schema })), close: () => client.end() }
}
