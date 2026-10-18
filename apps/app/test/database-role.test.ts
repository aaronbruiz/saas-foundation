import { env } from 'cloudflare:workers'
import { createDb } from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// ADR-0038: the app connects as `app_runtime`, a role that owns nothing and holds only the table
// privileges below. A new table gets no privileges until a migration grants them (no default
// privileges), so the app fails closed; adding it here records the decision.
const GRANTS: Record<string, string[]> = {
  user: ['INSERT', 'SELECT', 'UPDATE'],
  session: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  account: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  verification: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  organization: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  member: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  invitation: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  rate_limit: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  project: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  billing_subscription: ['INSERT', 'SELECT', 'UPDATE'],
  billing_webhook_event: ['INSERT', 'SELECT'],
}

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
let query: Query
let close: () => Promise<void>

beforeAll(async () => {
  const conn = await createDb(env.DB.connectionString)
  close = conn.close
  query = (rawDb(conn.db) as unknown as { $client: { query: Query } }).$client.query.bind(
    (rawDb(conn.db) as unknown as { $client: object }).$client,
  ) as Query
})
afterAll(() => close())

/** Runs one statement in a transaction that is always rolled back; returns the SQLSTATE or null. */
async function attempt(sql: string): Promise<string | null> {
  await query('BEGIN')
  try {
    await query(sql)
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown'
  } finally {
    await query('ROLLBACK')
  }
}

describe('the database role the app connects as', () => {
  it('is app_runtime, without superuser, bypass-RLS, role, database or replication rights', async () => {
    const { rows } = await query(
      `SELECT current_user AS name, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
         FROM pg_roles WHERE rolname = current_user`,
    )
    expect(rows).toEqual([
      {
        name: 'app_runtime',
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
      },
    ])
  })

  it('is a member of no other role and owns nothing in the database', async () => {
    const { rows: memberships } = await query(
      `SELECT roleid::regrole::text AS role FROM pg_auth_members WHERE member = current_user::regrole`,
    )
    expect(memberships).toEqual([])
    const { rows: owned } = await query(
      `SELECT relname FROM pg_class WHERE relowner = current_user::regrole AND relpersistence <> 't'
       UNION ALL SELECT nspname FROM pg_namespace WHERE nspowner = current_user::regrole
         AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
       UNION ALL SELECT proname FROM pg_proc WHERE proowner = current_user::regrole`,
    )
    expect(owned).toEqual([])
  })

  it('holds exactly the reviewed privileges on every table, and none on an unlisted one', async () => {
    const { rows } = await query(
      `SELECT c.relname AS table, p.privilege
         FROM pg_class c
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p(privilege)
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(current_user, c.oid, p.privilege)
        ORDER BY 1, 2`,
    )
    const held: Record<string, string[]> = {}
    for (const r of rows) (held[r.table as string] ??= []).push(r.privilege as string)
    expect(held).toEqual(Object.fromEntries(Object.entries(GRANTS).map(([t, p]) => [t, p.sort()])))
    const { rows: tables } = await query(
      `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')`,
    )
    expect(tables.map((t) => t.relname).sort()).toEqual(Object.keys(GRANTS).sort())
  })

  it('cannot change the schema, roles or migrations, or delete what it may only add', async () => {
    const refused = {
      createTable: await attempt('CREATE TABLE public.not_allowed (x int)'),
      alterTable: await attempt('ALTER TABLE project ADD COLUMN not_allowed text'),
      truncate: await attempt('TRUNCATE project'),
      deleteWebhookEvents: await attempt('DELETE FROM billing_webhook_event'),
      updateWebhookEvents: await attempt("UPDATE billing_webhook_event SET type = 'x'"),
      deleteSubscriptions: await attempt('DELETE FROM billing_subscription'),
      deleteUsers: await attempt('DELETE FROM "user"'),
      readMigrations: await attempt('SELECT 1 FROM drizzle.__drizzle_migrations'),
      createRole: await attempt('CREATE ROLE not_allowed'),
      createSchema: await attempt('CREATE SCHEMA not_allowed'),
    }
    // 42501 insufficient_privilege for every one.
    expect(refused).toEqual(Object.fromEntries(Object.keys(refused).map((k) => [k, '42501'])))
  })

  it("can't read, change or call the archive, or turn off, replace or remove its triggers (ADR-0039)", async () => {
    const refused = {
      readDeleted: await attempt('SELECT 1 FROM archive.deleted_row'),
      readEvents: await attempt('SELECT 1 FROM archive.auth_event'),
      insertEvent: await attempt(
        "INSERT INTO archive.auth_event (event, detail) VALUES ('x', '{}')",
      ),
      deleteArchive: await attempt('DELETE FROM archive.deleted_row'),
      truncateArchive: await attempt('TRUNCATE archive.auth_event'),
      callCapture: await attempt('SELECT archive.capture_delete()'),
      replaceFunction: await attempt(
        'CREATE OR REPLACE FUNCTION archive.audit_auth() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$',
      ),
      disableTrigger: await attempt('ALTER TABLE organization DISABLE TRIGGER archive_delete'),
      disableAll: await attempt('ALTER TABLE session DISABLE TRIGGER ALL'),
      dropTrigger: await attempt('DROP TRIGGER archive_delete ON project'),
      replaceTrigger: await attempt(
        'CREATE OR REPLACE TRIGGER audit_insert AFTER INSERT ON member FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()',
      ),
      replicationRole: await attempt("SET session_replication_role = 'replica'"),
      dropSchema: await attempt('DROP SCHEMA archive CASCADE'),
    }
    expect(refused).toEqual(Object.fromEntries(Object.keys(refused).map((k) => [k, '42501'])))
    const { rows } = await query(
      `SELECT has_schema_privilege('archive', 'USAGE') AS usage,
              has_schema_privilege('archive', 'CREATE') AS create`,
    )
    expect(rows).toEqual([{ usage: false, create: false }])
  })
})
