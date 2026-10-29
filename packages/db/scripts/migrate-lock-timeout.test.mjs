// Proves migrate.mjs bounds its lock wait (issue 174): behind a transaction that holds a conflicting
// lock it gives up within the limit, changes nothing, blocks competing writes for at most the limit,
// and applies once the blocker is gone. Uses a throwaway database and a synthetic migrations folder
// (the migrator is the unit under test, not our migrations). Needs the local Postgres (pnpm db:up);
// runs in `pnpm db:check`. LOCK_MS is small so the test is fast; production uses the 5 s default.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'

const base = process.env.LOCK_TEST_ADMIN_URL ?? 'postgres://app:app@localhost:5432/postgres'
const name = `lock_timeout_${process.pid}`
const url = (db) => {
  const u = new URL(base)
  u.pathname = `/${db}`
  return u.toString()
}
const LOCK_MS = 1000
const MARGIN_MS = 4000 // process start, connect and the migrator's own work
const script = new URL('migrate.mjs', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'migrate-lock-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const folder = (sqls) => {
  const f = join(dir, `m${sqls.length}`)
  mkdirSync(join(f, 'meta'), { recursive: true })
  const entries = sqls.map((sql, i) => {
    const tag = `${String(i).padStart(4, '0')}_step`
    writeFileSync(join(f, `${tag}.sql`), sql)
    return { idx: i, version: '7', when: 1700000000000 + i, tag, breakpoints: true }
  })
  writeFileSync(
    join(f, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  )
  return f
}
const first = `CREATE TABLE t (id int);`
// 0001 creates things before the ALTER that has to wait, so a partial apply would show.
const second = `CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1';--> statement-breakpoint
CREATE TABLE u (id int);--> statement-breakpoint
ALTER TABLE t ADD COLUMN c int;`
const v1 = () => folder([first])
const v2 = () => folder([first, second])

const run = (f, extra = {}) =>
  new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn('node', [script, f], {
      env: {
        ...process.env,
        DATABASE_URL: url(name),
        MIGRATE_LOCK_TIMEOUT_MS: String(LOCK_MS),
        ...extra,
      },
    })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, err, ms: Date.now() - t0 }))
  })

const snapshot = async (c) => {
  const q = async (sql) => (await c.query(sql)).rows
  return JSON.stringify({
    rel: await q(
      `SELECT c.relname, c.relkind, c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY 1`,
    ),
    cols: await q(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`,
    ),
    fn: await q(
      `SELECT p.proname, p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1`,
    ),
    trg: await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
    journal: await q(
      `SELECT count(*)::int AS n, max(created_at)::text AS last FROM drizzle.__drizzle_migrations`,
    ),
  })
}

let admin
before(async () => {
  admin = new pg.Client({ connectionString: base })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${name}`)
  await admin.query(`CREATE DATABASE ${name}`)
})
after(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.end()
})

test('a migration blocked by a conflicting lock fails within the limit, changes nothing, and applies once the blocker ends', async () => {
  const ok = await run(v1())
  assert.equal(ok.code, 0, ok.err)

  const blocker = new pg.Client({ connectionString: url(name) })
  const writer = new pg.Client({ connectionString: url(name) })
  const observer = new pg.Client({ connectionString: url(name) })
  await Promise.all([blocker.connect(), writer.connect(), observer.connect()])
  try {
    const before = await snapshot(observer)
    await blocker.query('BEGIN')
    await blocker.query('INSERT INTO t (id) VALUES (1)') // ROW EXCLUSIVE, conflicts with ALTER's ACCESS EXCLUSIVE

    const migration = run(v2())
    // Once the migrator is queued on the lock, a competing write queues behind it.
    for (let i = 0; i < 100; i++) {
      const { rows } = await observer.query(
        `SELECT 1 FROM pg_locks WHERE relation = 't'::regclass AND NOT granted`,
      )
      if (rows.length) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const w0 = Date.now()
    const blockedWrite = writer.query('INSERT INTO t (id) VALUES (2)').then(() => Date.now() - w0)
    const r = await migration
    assert.notEqual(r.code, 0)
    assert.match(r.err, /lock_timeout/)
    assert.ok(r.ms < LOCK_MS + MARGIN_MS, `migrator took ${r.ms} ms`)
    // The queued write needs ROW EXCLUSIVE, which the blocker (same mode) doesn't conflict with: it
    // only waited behind the migrator's pending request, so it is released at the timeout.
    const waited = await blockedWrite
    assert.ok(waited < LOCK_MS + 1500, `competing write blocked ${waited} ms`)

    assert.equal(await snapshot(observer), before)

    await blocker.query('ROLLBACK')
    const rerun = await run(v2())
    assert.equal(rerun.code, 0, rerun.err)
    const { rows } = await observer.query(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    )
    assert.equal(rows[0].n, 2)
    const cols = await observer.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 't' AND column_name = 'c'`,
    )
    assert.equal(cols.rowCount, 1)
  } finally {
    await Promise.all([blocker.end(), writer.end(), observer.end()].map((p) => p.catch(() => {})))
  }
})
