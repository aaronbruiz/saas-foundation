import { env } from 'cloudflare:workers'
import { createDb } from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authPost, signUp } from './helpers'

// ADR-0038: the app connects as `app_runtime`, a role that owns nothing and holds only the table
// privileges below. A new table gets no privileges until a migration grants them (no default
// privileges), so the app fails closed; adding it here records the decision.
const GRANTS: Record<string, string[]> = {
  user: ['INSERT', 'SELECT', 'UPDATE'],
  session: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  account: ['INSERT', 'SELECT', 'UPDATE'],
  verification: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  organization: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  member: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  invitation: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  rate_limit: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  project: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  billing_subscription: ['INSERT', 'SELECT', 'UPDATE'],
  billing_webhook_event: ['INSERT', 'SELECT'],
}
// The only functions of ours it may call (ADR-0040's webhook bypass), owner-owned definers.
const FUNCTIONS = ['billing_subscription_held_elsewhere(text,text)']

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

  it('gets no privileges by default and has no role-level settings (ADR-0038)', async () => {
    // Default privileges would grant every future table without a reviewed migration (invariant
    // 7); role settings (e.g. search_path) are cluster-wide, outside check-schema-sql.sh.
    expect(
      (await query('SELECT defaclrole::regrole::text AS role FROM pg_default_acl')).rows,
    ).toEqual([])
    const { rows } = await query(`SELECT rolconfig FROM pg_roles WHERE rolname = current_user`)
    expect(rows).toEqual([{ rolconfig: null }])
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

  it('is the only grantee besides the owner on any table, column, function or our schemas, with exactly the reviewed privileges', async () => {
    // Its effective privileges above can't show a grant to PUBLIC or another role; this reads the
    // ACLs themselves (check-schema-sql.sh leaves privileges to these tests).
    const { rows } = await query(
      `SELECT c.relnamespace::regnamespace::text || '.' || c.relname AS object,
              CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
              a.privilege_type AS privilege, a.is_grantable AS grantable
         FROM pg_class c, aclexplode(c.relacl) a
        WHERE c.relnamespace IN ('public'::regnamespace, 'archive'::regnamespace, 'drizzle'::regnamespace)
          AND a.grantee <> c.relowner
       UNION ALL
       SELECT c.relname || '.' || t.attname, 'column grant', '', false
         FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid
        WHERE c.relnamespace IN ('public'::regnamespace, 'archive'::regnamespace, 'drizzle'::regnamespace)
          AND t.attacl IS NOT NULL
       UNION ALL
       SELECT p.oid::regprocedure::text, CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
              a.privilege_type, a.is_grantable
         FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.pronamespace IN ('public'::regnamespace, 'archive'::regnamespace, 'drizzle'::regnamespace)
          AND a.grantee <> p.proowner
       UNION ALL
       SELECT n.nspname, CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
              a.privilege_type, a.is_grantable
         FROM pg_namespace n, aclexplode(n.nspacl) a
        WHERE n.nspname IN ('public', 'archive', 'drizzle') AND a.grantee <> n.nspowner
          AND a.grantee <> 'pg_database_owner'::regrole
        ORDER BY 1, 2, 3`,
    )
    const expected = [
      ...Object.entries(GRANTS).flatMap(([table, privileges]) =>
        privileges.map((privilege) => ({
          object: `public.${table}`,
          grantee: 'app_runtime',
          privilege,
          grantable: false,
        })),
      ),
      ...FUNCTIONS.map((fn) => ({
        object: fn,
        grantee: 'app_runtime',
        privilege: 'EXECUTE',
        grantable: false,
      })),
      { object: 'public', grantee: 'PUBLIC', privilege: 'USAGE', grantable: false },
      { object: 'public', grantee: 'app_runtime', privilege: 'USAGE', grantable: false },
    ].sort((x, y) =>
      `${x.object} ${x.grantee} ${x.privilege}` < `${y.object} ${y.grantee} ${y.privilege}`
        ? -1
        : 1,
    )
    expect(rows).toEqual(expected)
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
      deleteAccounts: await attempt('DELETE FROM account'),
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

  it('may call only the reviewed functions, each an owner-owned definer with a pinned search_path', async () => {
    const { rows } = await query(
      `SELECT p.oid::regprocedure::text AS fn, p.prosecdef, p.provolatile, p.proconfig,
              p.proowner = c.relowner AS owned_like_tables,
              ARRAY(SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                           || ':' || a.privilege_type
                           || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
                      FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner ORDER BY 1) AS grants
         FROM pg_proc p, pg_class c
        WHERE c.oid = 'public.billing_subscription'::regclass
          AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
          AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                            AND d.objid = p.oid AND d.deptype = 'e')
          AND has_function_privilege(current_user, p.oid, 'EXECUTE')
        ORDER BY 1`,
    )
    expect(rows.map((r) => r.fn)).toEqual(FUNCTIONS)
    for (const r of rows) {
      expect(r).toMatchObject({
        prosecdef: true,
        provolatile: 's',
        proconfig: ['search_path=pg_catalog, pg_temp'],
        owned_like_tables: true,
        grants: ['app_runtime:EXECUTE'],
      })
    }
  })

  it("can't replace, reconfigure, re-own, drop or share the webhook's definer function (ADR-0040)", async () => {
    const fn = 'public.billing_subscription_held_elsewhere(text, text)'
    const refused = {
      replace: await attempt(
        `CREATE OR REPLACE FUNCTION ${fn} RETURNS boolean LANGUAGE sql AS 'SELECT false'`,
      ),
      invoker: await attempt(`ALTER FUNCTION ${fn} SECURITY INVOKER`),
      searchPath: await attempt(`ALTER FUNCTION ${fn} SET search_path = pg_temp, public`),
      owner: await attempt(`ALTER FUNCTION ${fn} OWNER TO app_runtime`),
      rename: await attempt(`ALTER FUNCTION ${fn} RENAME TO not_allowed`),
      drop: await attempt(`DROP FUNCTION ${fn}`),
      overload: await attempt(
        `CREATE FUNCTION public.billing_subscription_held_elsewhere(varchar, varchar) RETURNS boolean LANGUAGE sql AS 'SELECT false'`,
      ),
    }
    expect(refused).toEqual(Object.fromEntries(Object.keys(refused).map((k) => [k, '42501'])))
    // Without the grant option a GRANT only warns; checked inside its transaction, before rollback.
    await query('BEGIN')
    try {
      await query(`GRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC`)
      const { rows } = await query(
        `SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS public_execute`,
      )
      expect(rows).toEqual([{ public_execute: false }])
    } finally {
      await query('ROLLBACK')
    }
  })
})

describe('auth flows without DELETE on account', () => {
  it('unlinking the only account is a clean 400 and keeps the account', async () => {
    const user = await signUp()
    const { rows } = await query(`SELECT id FROM account WHERE user_id = $1`, [user.userId])
    const res = await authPost('/unlink-account', { accountId: rows[0]!.id }, undefined, user)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' })
    expect((await query(`SELECT id FROM account WHERE user_id = $1`, [user.userId])).rows).toEqual(
      rows,
    )
  })
})
