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

// How long a request waits on an unresponsive or lost database (issue #173): connecting, each
// statement, and closing. A statement past its bound rejects; closing then drops the socket.
const CONNECT_TIMEOUT_MS = 5000
const QUERY_TIMEOUT_MS = 5000
const CLOSE_TIMEOUT_MS = 2000

/**
 * Opens a connection for one request. On Workers, pass `env.DB.connectionString` (Hyperdrive)
 * and call `close()` when done (e.g. via `ctx.waitUntil`). Never share a client across requests.
 */
export async function createDb(
  connectionString: string,
): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new GuardedClient({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  })
  // A lost backend reports an 'error' on the client. Unhandled, it throws inside pg-cloudflare's
  // read loop and stops it, so `end()` never sees the socket close and the request hangs (#173).
  // Statements in flight reject with that error anyway, and the client refuses new ones.
  client.on('error', () => {})
  // A socket that fails, which includes closing it just as the server does (#221), reports an
  // 'error' and no 'close', and `end()` only listens for the close.
  const socketFailed = new Promise<'failed'>((resolve) => {
    client.connection.stream.once('error', () => resolve('failed'))
  })
  await client.connect()
  return { db: asDb(drizzle(client, { schema })), close: () => end(client, socketFailed) }
}

/**
 * `client.end()`, or the socket dropped if it has failed or the server hasn't closed it within
 * the bound.
 */
async function end(client: GuardedClient, socketFailed: Promise<'failed'>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS)
  })
  try {
    if ((await Promise.race([client.end(), socketFailed, timedOut])) !== undefined) {
      try {
        client.connection.stream.destroy()
      } catch {
        // Already closed.
      }
    }
  } finally {
    clearTimeout(timer)
  }
}
