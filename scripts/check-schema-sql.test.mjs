// Proves scripts/check-schema-sql.sh against real Postgres, with probes applied to the migrated
// database as the restricted migration login (SCHEMA_CHECK_PROBE): what that role can do outside
// the Drizzle schema and the registry, the gate reports (one run, PROBES); what only a superuser
// can do (changing built-ins, creating in system schemas, switching to or granting a superuser) is
// refused and leaves nothing behind (one run, REFUSED: each wrapped so that success fails the run,
// and the gate must then pass). The comparator's own rules are proven without a database by
// compare-catalogs.test.mjs. Needs the local Postgres container
// (pnpm db:up), so it runs in `pnpm db:check` and ci.yml, not in `pnpm lint`.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const script = new URL('check-schema-sql.sh', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'check-schema-sql-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// Each probe and the report line that must name it.
const PROBES = [
  [
    `CREATE FUNCTION public.probe_definer() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER AS 'SELECT organization_id FROM public.billing_subscription'`,
    /only in the migrations: function public\.probe_definer\(\)/,
  ],
  [
    `CREATE TRIGGER probe_trigger AFTER INSERT ON public.project FOR EACH ROW EXECUTE FUNCTION archive.capture_delete()`,
    /only in the migrations: trigger public\.project\.probe_trigger/,
  ],
  [
    `CREATE TABLE archive.probe_copy (x text)`,
    /only in the migrations: relation archive\.probe_copy/,
  ],
  [
    `ALTER FUNCTION public.billing_subscription_held_elsewhere(text, text) RESET search_path`,
    /registered SQL-only object changed: function public\.billing_subscription_held_elsewhere/,
  ],
  [
    `DROP TRIGGER archive_delete ON public.project`,
    /registered SQL-only object is missing: trigger public\.project\.archive_delete/,
  ],
  [
    `ALTER TABLE public.member DISABLE TRIGGER audit_insert`,
    /registered SQL-only object changed: trigger public\.member\.audit_insert/,
  ],
  [
    `CREATE INDEX probe_idx ON public.project (name)`,
    /only in the migrations: index public\.probe_idx/,
  ],
  [
    `ALTER TABLE public.project DROP CONSTRAINT project_organization_id_organization_id_fk`,
    /only in the schema: constraint public\.project\.project_organization_id_organization_id_fk/,
  ],
  [
    `CREATE FUNCTION drizzle.probe() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT true'`,
    /only in the migrations: function drizzle\.probe\(\)/,
  ],
  [
    `CREATE PUBLICATION probe_pub FOR TABLE public."user"`,
    /only in the migrations: publication probe_pub/,
  ],
  [
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app_runtime`,
    /only in the migrations: default_acl public\.schema_check_owner_[0-9a-f]+\.r/,
  ],
  [
    `CREATE TYPE public.probe_t AS ENUM ('a'); CREATE CAST (public.probe_t AS text) WITH INOUT`,
    /only in the migrations: cast probe_t->text/,
  ],
  [
    // Every database the login owns, as a migration could: the reference database doesn't exist yet.
    `DO $$ DECLARE d record; BEGIN FOR d IN SELECT datname FROM pg_database WHERE datdba = current_user::regrole LOOP EXECUTE format('ALTER DATABASE %I CONNECTION LIMIT 100', d.datname); END LOOP; END $$`,
    /differs: database current/,
  ],
  [`SELECT lo_create(0)`, /only in the migrations: large_objects count/],
  [
    `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET work_mem = %L', current_database(), '8MB'); END $$`,
    /only in the migrations: database_setting \*/,
  ],
]

// Superuser-only changes, including the built-in alterations a superuser login escaped the gate
// with: each must fail with insufficient_privilege (42501) for the migration login.
const REFUSED = [
  `ALTER OPERATOR pg_catalog.= (integer, integer) SET (RESTRICT = NONE, JOIN = NONE)`,
  `ALTER OPERATOR FAMILY pg_catalog.integer_ops USING btree DROP FUNCTION 1 (integer, smallint)`,
  `ALTER TEXT SEARCH CONFIGURATION pg_catalog.english DROP MAPPING FOR asciiword`,
  `ALTER FUNCTION pg_catalog.pg_read_file(text) SECURITY DEFINER`,
  `CREATE OPERATOR FAMILY pg_catalog.probe_family USING btree`,
  `CREATE FUNCTION pg_catalog.probe_sys() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
  `CREATE TABLE information_schema.probe_sys (x int)`,
  `CREATE FOREIGN DATA WRAPPER probe_fdw`,
  `CREATE CAST (text AS money) WITH INOUT`,
  `CREATE ACCESS METHOD probe_am TYPE TABLE HANDLER heap_tableam_handler`,
  `CREATE EXTENSION file_fdw`,
  `SET ROLE app`,
  `SET SESSION AUTHORIZATION app`,
  `ALTER ROLE CURRENT_USER SUPERUSER`,
  `ALTER ROLE app_runtime SUPERUSER`,
  `CREATE ROLE probe_super SUPERUSER`,
  `GRANT app TO CURRENT_USER`,
  `GRANT pg_execute_server_program TO CURRENT_USER`,
]

const gate = (sql) => {
  const probe = join(dir, `probe-${Math.random().toString(36).slice(2)}.sql`)
  writeFileSync(probe, sql)
  return spawnSync(script, { encoding: 'utf8', env: { ...process.env, SCHEMA_CHECK_PROBE: probe } })
}

test('every probed object the migration login can create or change outside the registry fails the gate', () => {
  const r = gate(PROBES.map(([sql]) => `${sql};`).join('\n'))
  assert.equal(r.status, 1, r.stderr)
  for (const [sql, report] of PROBES) assert.match(r.stderr, report, `not reported: ${sql}`)
})

test('superuser-only changes are refused to the migration login and leave the catalog unchanged', () => {
  const wrapped = REFUSED.map(
    (sql) =>
      `DO $probe$ BEGIN EXECUTE $sql$${sql}$sql$; RAISE EXCEPTION 'probe allowed: %', $sql$${sql}$sql$; ` +
      `EXCEPTION WHEN insufficient_privilege THEN NULL; END $probe$;`,
  )
  const r = gate(wrapped.join('\n'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /migrations build the schema/)
})

/** The definition the gate reports for an object only the migrations have. */
const reported = (r, key) => {
  const line = r.stderr.split('\n').find((l) => l.startsWith(`only in the migrations: ${key} `))
  assert.ok(line, `${key} not reported: ${r.stderr}`)
  return line
}

test("a registered publication's columns and row filter, and a statistics object's target, are part of its definition", () => {
  const stats = `CREATE STATISTICS public.probe_stats ON name, created_by FROM public.project;`
  const narrow = gate(
    `CREATE PUBLICATION probe_pub FOR TABLE public."user" (id) WHERE (id = 'allowed') WITH (publish = 'insert');\n${stats}`,
  )
  const wide = gate(
    `CREATE PUBLICATION probe_pub FOR TABLE public."user" WITH (publish = 'insert');\n${stats}\nALTER STATISTICS public.probe_stats SET STATISTICS 0;`,
  )
  assert.notEqual(
    reported(narrow, 'publication probe_pub'),
    reported(wide, 'publication probe_pub'),
  )
  assert.notEqual(
    reported(narrow, 'statistics public.probe_stats'),
    reported(wide, 'statistics public.probe_stats'),
  )
})

test('a migration that creates a role fails the identity check', () => {
  const role = `probe_role_${Math.random().toString(36).slice(2, 10)}`
  try {
    const r = gate(`CREATE ROLE ${role};`)
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /isn't exactly the restricted role \(after migrating\)/)
  } finally {
    const container = execFileSync(
      'docker',
      ['ps', '-q', '--filter', `publish=${process.env.POSTGRES_PORT ?? 5432}`],
      { encoding: 'utf8' },
    ).trim()
    execFileSync('docker', [
      'exec',
      container,
      'psql',
      '-qAtX',
      '-U',
      'app',
      '-d',
      'app',
      '-c',
      `DROP ROLE IF EXISTS ${role}`,
    ])
  }
})
