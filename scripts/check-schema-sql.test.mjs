// Proves scripts/check-schema-sql.sh's catalog query sees each kind of object a migration could
// add outside the Drizzle schema, against real Postgres: one run applies every probe below to the
// migrated database (SCHEMA_CHECK_PROBE) and the gate must report each. The comparator's own rules
// are proven without a database by compare-catalogs.test.mjs. Needs the local Postgres container
// (pnpm db:up), so it runs in `pnpm db:check` and ci.yml, not in `pnpm lint`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
    /only in the migrations: default_acl public\.app\.r/,
  ],
  [
    `CREATE FUNCTION pg_catalog.probe_sys() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
    /only in the migrations: system_object pg_proc pg_catalog\.probe_sys\(\)/,
  ],
  [
    `CREATE TABLE information_schema.probe_sys (x int)`,
    /only in the migrations: system_object pg_class information_schema\.probe_sys/,
  ],
  [
    `CREATE FOREIGN DATA WRAPPER probe_fdw`,
    /only in the migrations: foreign_data_wrapper probe_fdw/,
  ],
  [
    `CREATE SERVER probe_srv FOREIGN DATA WRAPPER probe_fdw`,
    /only in the migrations: foreign_server probe_srv/,
  ],
  [
    `CREATE USER MAPPING FOR app_runtime SERVER probe_srv`,
    /only in the migrations: user_mapping probe_srv\.app_runtime/,
  ],
  [`CREATE CAST (text AS money) WITH INOUT`, /only in the migrations: cast text->money/],
  [
    `CREATE ACCESS METHOD probe_am TYPE TABLE HANDLER heap_tableam_handler`,
    /only in the migrations: access_method probe_am/,
  ],
  [`SELECT lo_create(0)`, /only in the migrations: large_objects count/],
  [
    `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET work_mem = %L', current_database(), '8MB'); END $$`,
    /only in the migrations: database_setting \*/,
  ],
]

test('every probed object outside the Drizzle schema and the registry fails the gate', () => {
  const probe = join(dir, 'probe.sql')
  writeFileSync(probe, PROBES.map(([sql]) => `${sql};`).join('\n'))
  const r = spawnSync(script, {
    encoding: 'utf8',
    env: { ...process.env, SCHEMA_CHECK_PROBE: probe },
  })
  assert.equal(r.status, 1, r.stderr)
  for (const [sql, report] of PROBES) assert.match(r.stderr, report, `not reported: ${sql}`)
})
