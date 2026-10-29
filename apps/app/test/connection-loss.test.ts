import { env } from 'cloudflare:workers'
import { createDb, type Db } from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { describe, expect, it } from 'vitest'
import { withDb } from '../src/server/db'

// Issue #173: a request whose database backend is lost must still get an answer, within a bound.

type Client = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: { pid: number }[] }>
}
const client = (db: Db) => (rawDb(db) as unknown as { $client: Client }).$client

/** Rejects if `promise` hasn't settled within `ms`. */
const within = <T>(ms: number, promise: Promise<T>) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms),
    ),
  ])

describe('a lost database connection', () => {
  it('still closes when its backend is terminated as the request ends', async () => {
    // The server's FATAL reaches the client after it has started closing, with nothing in flight.
    const killer = await createDb(env.DB.connectionString)
    try {
      for (let i = 0; i < 20; i++) {
        const { db, close } = await createDb(env.DB.connectionString)
        const { pid } = (await client(db).query('select pg_backend_pid() as pid')).rows[0]!
        await client(killer.db).query('select pg_terminate_backend($1)', [pid])
        await within(1000, close())
      }
    } finally {
      await killer.close()
    }
  }, 60_000)

  it('a statement that gets no answer fails within the query bound and the connection closes', async () => {
    const started = Date.now()
    const stuck = within(
      8000,
      withDb((db) => client(db).query('select pg_sleep(30)')),
    )
    await expect(stuck).rejects.toThrow('Query read timeout')
    expect(Date.now() - started).toBeLessThan(8000)
  }, 10_000)
})
