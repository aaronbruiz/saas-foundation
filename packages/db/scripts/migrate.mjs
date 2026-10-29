// Trusted migrator for PR previews (ADR-0013 step 3): applies a migrations folder that came from
// an untrusted build artifact, treating it strictly as data. Unlike `drizzle-kit migrate`, it runs
// no config file from that folder's commit. Same bookkeeping as drizzle-kit
// (`drizzle.__drizzle_migrations`), so branches migrated either way stay compatible.
// Usage: DATABASE_URL=... node packages/db/scripts/migrate.mjs <migrations-folder>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

const fail = (msg) => {
  console.error(`[migrate] ERROR: ${msg}`)
  process.exit(1)
}

const folder = process.argv[2]
if (!folder) fail('usage: migrate.mjs <migrations-folder>')
if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set')

// Only drizzle-kit's own output: <tag>.sql files and meta/*.json. No symlinks, no subfolders.
const tagPattern = /^\d{4}_[a-z0-9_]+$/
for (const name of readdirSync(folder)) {
  const st = statSync(join(folder, name), { throwIfNoEntry: false })
  if (name === 'meta' && st?.isDirectory()) continue
  if (!st?.isFile() || !name.endsWith('.sql') || !tagPattern.test(name.slice(0, -4)))
    fail(`unexpected entry in migrations folder: ${JSON.stringify(name)}`)
}
for (const name of readdirSync(join(folder, 'meta'))) {
  if (!/^[a-z0-9_]+\.json$/.test(name) || !statSync(join(folder, 'meta', name)).isFile())
    fail(`unexpected entry in migrations meta folder: ${JSON.stringify(name)}`)
}
// Journal tags become file paths inside drizzle's reader: keep them to the plain tag shape.
const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'))
if (!Array.isArray(journal.entries)) fail('journal has no entries array')
for (const e of journal.entries) {
  if (typeof e?.tag !== 'string' || !tagPattern.test(e.tag))
    fail(`bad journal tag: ${JSON.stringify(e?.tag)}`)
  if (!Number.isSafeInteger(e.when)) fail(`bad journal timestamp for ${e.tag}`)
}

// Bound every lock wait of the run (issue 174): a DDL statement stuck behind a long transaction
// also queues every later writer on that table. 5 s: longer than any normal lock hand-off, short
// enough that blocked sign-ins stay tolerable. Session-level, so it covers each migration's
// transaction; a timeout aborts that transaction and the run, leaving the journal unchanged.
const lockMs = Number(process.env.MIGRATE_LOCK_TIMEOUT_MS ?? 5000)
if (!Number.isSafeInteger(lockMs) || lockMs < 1)
  fail('MIGRATE_LOCK_TIMEOUT_MS must be a positive integer')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  await client.query(`SET lock_timeout = ${lockMs}`)
  await migrate(drizzle(client), { migrationsFolder: folder })
  console.error(
    `[migrate] applied ${journal.entries.length} journal entries (already-applied ones skipped)`,
  )
} catch (e) {
  if (e?.code === '55P03' || e?.cause?.code === '55P03')
    fail(
      `gave up after lock_timeout (${lockMs} ms); nothing was applied. Find long open transactions holding table locks with: SELECT a.pid, a.state, a.xact_start, l.relation::regclass, l.mode, left(a.query, 80) FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.granted AND l.relation IS NOT NULL AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND a.pid <> pg_backend_pid() ORDER BY a.xact_start; then retry in an idle window.`,
    )
  throw e
} finally {
  await client.end()
}
