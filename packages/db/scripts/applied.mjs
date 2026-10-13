// Prints the migrations a database has applied, as drizzle records them in
// `drizzle.__drizzle_migrations`: a JSON array of `{ hash, created_at }`, `created_at` being the
// journal's `when` (ms). Read-only. Used by the release and rollback workflows (ADR-0029) to tell
// which journal entries are pending and which applied ones a rollback target lacks.
// Usage: DATABASE_URL=... node packages/db/scripts/applied.mjs
import pg from 'pg'

if (!process.env.DATABASE_URL) {
  console.error('[applied] ERROR: DATABASE_URL is not set')
  process.exit(1)
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const exists = await client.query(`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`)
  const rows = exists.rows[0].t
    ? (
        await client.query(
          'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
        )
      ).rows
    : []
  console.log(JSON.stringify(rows.map((r) => ({ hash: r.hash, created_at: Number(r.created_at) }))))
} finally {
  await client.end()
}
