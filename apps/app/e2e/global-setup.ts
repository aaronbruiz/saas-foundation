// Local runs only (no BASE_URL): every browser request reaches the dev server from 127.0.0.1
// (Miniflare sets CF-Connecting-IP from the socket), and one run spends the whole sign-in budget
// (5 a minute, ADR-0005), which Better Auth keeps in the database. Without this, a second run
// within a minute failed with 429s. Previews get a fresh database on every deploy.
import { readFileSync } from 'node:fs'
import { createDb } from '@saas-foundation/db'
import { rawDb, schema } from '@saas-foundation/db/internal'
import { enableLocalRuntimeLogin } from '../test/local-runtime-role.ts'

type Query = (q: string) => Promise<{ rows: Record<string, unknown>[] }>

/**
 * Journal entries the dev database hasn't applied. Like drizzle's migrator: every entry newer than
 * the last applied one (`created_at` is the journal's `when`), or all of them without the table.
 */
async function pendingMigrations(query: Query) {
  const journal = new URL('../../../packages/db/drizzle/meta/_journal.json', import.meta.url)
  const { entries } = JSON.parse(readFileSync(journal, 'utf8')) as {
    entries: { tag: string; when: number }[]
  }
  const { rows } = await query(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as migrated",
  )
  if (!rows[0]!.migrated) return entries.map((e) => e.tag)
  const last = (await query('select max(created_at) as last from drizzle.__drizzle_migrations'))
    .rows[0]!.last as string | null
  return entries.filter((e) => last === null || e.when > Number(last)).map((e) => e.tag)
}

export default async function setup() {
  if (process.env.BASE_URL) return
  // The local dev database (wrangler.jsonc `localConnectionString`); known local credentials.
  const { db, close } = await createDb('postgres://app:app@localhost:5432/app')
  try {
    // CI migrates before e2e. Locally a stale dev database passed the suite without exercising the
    // newest migrations, so refuse to start rather than migrate it behind the developer's back.
    const client = (rawDb(db) as unknown as { $client: { query: Query } }).$client
    const pending = await pendingMigrations((q) => client.query(q))
    if (pending.length > 0)
      throw new Error(
        `The dev database has ${pending.length} pending migration(s): ${pending.join(', ')}. ` +
          'Run `pnpm db:migrate`, then start the e2e tests again.',
      )
    // The dev server connects as the runtime role (ADR-0038; wrangler.jsonc localConnectionString).
    await enableLocalRuntimeLogin()
    await rawDb(db).delete(schema.rateLimit)
  } finally {
    await close()
  }
}
