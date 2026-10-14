// Prints the migrations a database has applied, as drizzle records them in
// `drizzle.__drizzle_migrations`: a JSON array of `{ hash, created_at }`, `created_at` being the
// journal's `when` (ms). Read-only. Used by the release and rollback workflows (ADR-0029) to tell
// which journal entries are pending and which applied ones a rollback target lacks. Production
// always has the table, so a missing (the query throws) or empty one means the wrong database: it's
// an error, never "nothing applied" (which would let every guard pass).
// Usage: DATABASE_URL=... node packages/db/scripts/applied.mjs
import pg from 'pg'

if (!process.env.DATABASE_URL) {
  console.error('[applied] ERROR: DATABASE_URL is not set')
  process.exit(1)
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const { rows } = await client.query(
    'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
  )
  if (rows.length === 0) {
    console.error('[applied] ERROR: drizzle.__drizzle_migrations is empty (wrong database?)')
    process.exitCode = 1
  } else {
    console.log(
      JSON.stringify(rows.map((r) => ({ hash: r.hash, created_at: Number(r.created_at) }))),
    )
  }
} finally {
  await client.end()
}
