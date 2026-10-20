#!/usr/bin/env bash
# AGENTS.md invariant 10: the migrations' SQL builds exactly the schema in packages/db/src/schema.
# Migrates one fresh database, applies the whole TypeScript schema generated from scratch to
# another (after the migrations, which create the roles policies name), and compares the two
# catalogs. scripts/check-migrations.mjs compares snapshots, not SQL, so a migration whose SQL
# omits something its snapshot declares (an index, a constraint, a default) only shows up here.
#
# One line per object, sorted by name (a migration appends a new column at the end while the
# from-scratch SQL creates it in schema order, so column order is ignored), every definition
# JSON-escaped (a multi-line default stays on its line, so nothing can hide in it). Covered:
# schemas; relations and composite types (kind, RLS, options such as a view's security_invoker,
# replica identity); columns (type, nullability, default, identity, generated, collation,
# storage, compression, statistics target, options); constraints; indexes; standalone types
# (enums, domains, ranges...); collations; sequences; functions and aggregates; triggers (with
# firing state, including the internal ones enforcing foreign keys); rules; statistics; policies;
# views; event triggers; extensions; and by name operators, operator classes and families,
# conversions and text-search objects; publications, subscriptions, foreign-data wrappers,
# servers and user mappings; casts, transforms, access methods and languages; large objects;
# default privileges and this database's settings. Every schema is compared, pg_catalog,
# information_schema and pg_toast included (both databases come from the same template, so a
# built-in object created, changed or dropped by a migration differs); only TOAST tables and their
# indexes, whose names carry OIDs, are left out. Also left out: owners and privileges on existing
# objects (checked by apps/app/test/database-role.test.ts) and cluster-wide state (roles and their
# settings: database-role.test.ts).
#
# SCHEMA_CHECK_PROBE=<file.sql> applies extra SQL to the migrated database only, as the migration
# login, to prove the gate fails (scripts/check-schema-sql.test.mjs); it can only add differences, never hide one.
#
# Objects that custom migrations create on purpose and the Drizzle schema can't express (the
# archive schema, triggers, functions: ADR-0039, ADR-0040) are listed one by one, with a hash of
# their definition, in packages/db/sql-only-objects.tsv. scripts/compare-catalogs.mjs checks each
# registered object exists exactly as registered and compares everything else exactly.
#
# Migrations run as `schema_check_owner`, a login without superuser that mirrors production's
# `app_owner` on Neon (ADR-0038; R06 role inspection 2026-10-15): BYPASSRLS, CREATEROLE, CREATEDB,
# REPLICATION, owner of both databases, and a member (inherit, no SET) of a NOLOGIN stand-in for
# `neon_superuser` holding pg_read_all_data and pg_write_all_data. It logs in itself (no SET ROLE
# from a superuser that RESET ROLE could undo), and its identity, attributes and memberships are
# checked before migrating. So the gate covers what the production migration role can do: DDL only
# a superuser may run (changing PostgreSQL's built-in objects, creating in pg_catalog) fails here,
# as it would in production (proven by scripts/check-schema-sql.test.mjs). Not reproduced locally:
# Neon's other neon_superuser rights (e.g. its extension allowlist) and the default privileges its
# `cloud_admin` sets in `public` (ADR-0038 G3 verifies those on production).
#
# Uses the Postgres container serving localhost:5432 (POSTGRES_PORT; POSTGRES_CONTAINER, default:
# the one publishing that port, which also works from a worktree), creates and drops two databases in it,
# and creates or resets the two roles above (cluster-wide, local credentials). Run by ci.yml and
# `pnpm db:check`.
set -euo pipefail
cd "$(dirname "$0")/.."

port="${POSTGRES_PORT:-5432}"
container="${POSTGRES_CONTAINER:-$(docker ps -q --filter publish="$port")}"
[ -n "$container" ] || { echo "check-schema-sql: no Postgres container (pnpm db:up)" >&2; exit 2; }
owner=schema_check_owner
owner_url="postgres://$owner:$owner@localhost:$port"
migrated=schema_check_migrated
fresh=schema_check_fresh
work="$(mktemp -d)"

# $1 role (app: the container's superuser, for setup only), $2 database, $3 SQL.
psql_as() {
  docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$container" \
    psql -qAtX -v ON_ERROR_STOP=1 -U "$1" -d "$2" -c "$3"
}
psql_in() { psql_as app "$@"; }
drop() { for db in "$migrated" "$fresh"; do psql_in app "DROP DATABASE IF EXISTS $db" >/dev/null; done; }
cleanup() { drop || true; rm -rf "$work"; }
trap cleanup EXIT

drop
psql_in app "
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'schema_check_neon_superuser') THEN
      CREATE ROLE schema_check_neon_superuser;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$owner') THEN CREATE ROLE $owner; END IF;
  END \$\$;
  ALTER ROLE schema_check_neon_superuser NOLOGIN NOSUPERUSER BYPASSRLS CREATEROLE CREATEDB REPLICATION INHERIT;
  ALTER ROLE $owner LOGIN PASSWORD '$owner' NOSUPERUSER BYPASSRLS CREATEROLE CREATEDB REPLICATION INHERIT;
  GRANT pg_read_all_data, pg_write_all_data TO schema_check_neon_superuser;
  GRANT schema_check_neon_superuser TO $owner WITH INHERIT TRUE, SET FALSE;" >/dev/null
for db in "$migrated" "$fresh"; do psql_in app "CREATE DATABASE $db OWNER $owner" >/dev/null; done
# Fail closed unless the migration login is exactly the restricted role: not a superuser, no way to
# become one, and only the memberships above, plus (once migration 0005 has created app_runtime
# with it) the ADMIN-only grant PostgreSQL 16+ gives a role's creator, as production app_owner has.
identity="$(psql_as "$owner" "$migrated" "
  SELECT current_user = '$owner' AND session_user = '$owner'
     AND NOT r.rolsuper AND r.rolbypassrls AND r.rolcreaterole AND r.rolcreatedb AND r.rolreplication
     AND NOT EXISTS (SELECT FROM pg_roles s WHERE s.rolsuper AND pg_has_role(session_user, s.oid, 'MEMBER'))
     AND (SELECT string_agg(m.roleid::regrole::text || ':' || m.inherit_option || m.set_option || m.admin_option, ',' ORDER BY m.roleid::regrole::text)
            FROM pg_auth_members m WHERE m.member = r.oid)
         IN ('schema_check_neon_superuser:truefalsefalse',
             'app_runtime:falsefalsetrue,schema_check_neon_superuser:truefalsefalse')
     AND (SELECT string_agg(m.roleid::regrole::text, ',' ORDER BY m.roleid::regrole::text) FROM pg_auth_members m
            WHERE m.member = 'schema_check_neon_superuser'::regrole) = 'pg_read_all_data,pg_write_all_data'
     AND (SELECT datdba FROM pg_database WHERE datname = current_database()) = r.oid
  FROM pg_roles r WHERE r.rolname = current_user")"
[ "$identity" = t ] || { echo "check-schema-sql: the migration login isn't the restricted $owner role" >&2; exit 2; }
kit() {
  DATABASE_URL="$owner_url/$1" pnpm --filter @saas-foundation/db exec drizzle-kit "${@:2}" </dev/null >"$work/$1.log" 2>&1 \
    || { cat "$work/$1.log" >&2; echo "check-schema-sql: drizzle-kit ${*:2} failed" >&2; exit 1; }
}
kit "$migrated" migrate
# The migrations ran as that login: it owns everything they created.
others="$(psql_in "$migrated" "
  SELECT count(*) FROM (
    SELECT relowner AS o FROM pg_class WHERE relnamespace IN ('public'::regnamespace, 'archive'::regnamespace, 'drizzle'::regnamespace)
    UNION ALL SELECT proowner FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'archive'::regnamespace)
    UNION ALL SELECT nspowner FROM pg_namespace WHERE nspname IN ('archive', 'drizzle')
  ) x WHERE o <> '$owner'::regrole")"
[ "$others" = 0 ] || { echo "check-schema-sql: $others migrated objects aren't owned by $owner" >&2; exit 2; }
if [ -n "${SCHEMA_CHECK_PROBE:-}" ]; then
  docker exec -i "$container" psql -qX -v ON_ERROR_STOP=1 -U "$owner" -d "$migrated" <"$SCHEMA_CHECK_PROBE" >/dev/null
fi
# The reference: the whole schema generated from scratch by the same generator the migrations come
# from, applied in one transaction (`drizzle-kit push` 0.31 drops policies' USING/WITH CHECK).
pnpm --filter @saas-foundation/db exec drizzle-kit generate --dialect postgresql \
  --schema ./src/schema/index.ts --out "$work/fresh" </dev/null >"$work/fresh.log" 2>&1 \
  || { cat "$work/fresh.log" >&2; echo "check-schema-sql: generating the schema from scratch failed" >&2; exit 1; }
cat "$work"/fresh/*.sql | docker exec -i "$container" psql -qX -1 -v ON_ERROR_STOP=1 -U "$owner" -d "$fresh" >/dev/null

catalog="$(cat <<'SQL'
WITH ns AS (
  SELECT oid, nspname FROM pg_namespace
  WHERE nspname NOT LIKE 'pg\_temp\_%' AND nspname NOT LIKE 'pg\_toast\_temp\_%'
), rel AS (
  SELECT c.*, ns.nspname || '.' || c.relname AS qname FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
)
SELECT kind || E'\t' || to_json(name)::text || E'\t' || detail FROM (
  SELECT 'schema' AS kind, nspname::text AS name, '' AS detail FROM ns
  UNION ALL
  SELECT 'relation', qname, json_build_object('kind', relkind, 'persistence', relpersistence,
      'rls', relrowsecurity, 'force_rls', relforcerowsecurity, 'replica_identity', relreplident,
      'options', (SELECT json_agg(o ORDER BY o) FROM unnest(reloptions) o))::text
    FROM rel WHERE relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
  UNION ALL
  SELECT 'column', r.qname || '.' || a.attname, json_build_object(
      'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity,
      'generated', a.attgenerated, 'collation', (SELECT collname FROM pg_collation WHERE oid = a.attcollation),
      'storage', a.attstorage, 'compression', a.attcompression, 'statistics', a.attstattarget,
      'options', (SELECT json_agg(o ORDER BY o) FROM unnest(a.attoptions) o))::text
    FROM pg_attribute a JOIN rel r ON r.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE r.relkind IN ('r', 'p', 'v', 'm', 'f', 'c') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint', r.qname || '.' || k.conname, to_json(pg_get_constraintdef(k.oid))::text
    FROM pg_constraint k JOIN rel r ON r.oid = k.conrelid
  UNION ALL
  SELECT 'index', qname, to_json(pg_get_indexdef(oid))::text FROM rel WHERE relkind IN ('i', 'I')
    AND NOT EXISTS (SELECT FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid WHERE x.indexrelid = rel.oid AND t.relkind = 't')
  UNION ALL
  SELECT 'type', ns.nspname || '.' || t.typname, json_build_object('kind', t.typtype,
      'labels', (SELECT json_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = t.oid),
      'base', format_type(t.typbasetype, t.typtypmod), 'not_null', t.typnotnull, 'default', t.typdefault)::text
    FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
    -- every standalone type (enum, domain, base, range, multirange, pseudo); a relation's row type
    -- and implicit array types come with the relation or type they belong to
    WHERE t.typrelid = 0 AND NOT (t.typcategory = 'A' AND t.typelem <> 0)
  UNION ALL
  SELECT 'collation', ns.nspname || '.' || c.collname || ' ' || c.collencoding, json_build_object('provider', c.collprovider,
      'deterministic', c.collisdeterministic, 'collate', c.collcollate, 'ctype', c.collctype,
      'locale', c.colllocale, 'rules', c.collicurules)::text
    FROM pg_collation c JOIN ns ON ns.oid = c.collnamespace
  UNION ALL
  -- Any other namespaced object a custom migration could add, by name.
  SELECT 'operator', ns.nspname || '.' || o.oprname || '(' || o.oprleft::regtype || ',' || o.oprright::regtype || ')',
      json_build_object('function', o.oprcode::regproc::text)::text
    FROM pg_operator o JOIN ns ON ns.oid = o.oprnamespace
  UNION ALL
  SELECT 'opclass', ns.nspname || '.' || c.opcname || ' USING ' || (SELECT amname FROM pg_am WHERE oid = c.opcmethod),
      json_build_object('family', c.opcfamily::regclass::text, 'type', c.opcintype::regtype::text, 'default', c.opcdefault)::text
    FROM pg_opclass c JOIN ns ON ns.oid = c.opcnamespace
  UNION ALL
  SELECT 'opfamily', ns.nspname || '.' || f.opfname || ' USING ' || (SELECT amname FROM pg_am WHERE oid = f.opfmethod), ''
    FROM pg_opfamily f JOIN ns ON ns.oid = f.opfnamespace
  UNION ALL
  SELECT 'conversion', ns.nspname || '.' || c.conname, '' FROM pg_conversion c JOIN ns ON ns.oid = c.connamespace
  UNION ALL
  SELECT 'ts_config', ns.nspname || '.' || c.cfgname, '' FROM pg_ts_config c JOIN ns ON ns.oid = c.cfgnamespace
  UNION ALL
  SELECT 'ts_dict', ns.nspname || '.' || d.dictname, '' FROM pg_ts_dict d JOIN ns ON ns.oid = d.dictnamespace
  UNION ALL
  SELECT 'ts_parser', ns.nspname || '.' || p.prsname, '' FROM pg_ts_parser p JOIN ns ON ns.oid = p.prsnamespace
  UNION ALL
  SELECT 'ts_template', ns.nspname || '.' || t.tmplname, '' FROM pg_ts_template t JOIN ns ON ns.oid = t.tmplnamespace
  UNION ALL
  SELECT 'sequence', schemaname || '.' || sequencename, json_build_object('type', data_type::text,
      'start', start_value, 'min', min_value, 'max', max_value, 'increment', increment_by,
      'cycle', cycle, 'cache', cache_size)::text
    FROM pg_sequences WHERE schemaname IN (SELECT nspname FROM ns)
  UNION ALL
  SELECT 'function', ns.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      CASE WHEN p.prokind = 'a' THEN '"aggregate"' ELSE to_json(pg_get_functiondef(p.oid))::text END
    FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
  UNION ALL
  SELECT 'trigger', r.qname || '.' || g.tgname,
      json_build_object('def', pg_get_triggerdef(g.oid), 'enabled', g.tgenabled)::text
    FROM pg_trigger g JOIN rel r ON r.oid = g.tgrelid WHERE NOT g.tgisinternal
  UNION ALL
  -- Internal triggers enforce foreign keys; their names carry OIDs, so they're keyed by constraint
  -- and function, and compared by firing state (DISABLE TRIGGER ALL turns enforcement off).
  SELECT 'constraint_trigger', r.qname || '.' || k.conname || '.' || f.proname,
      json_agg(g.tgenabled ORDER BY g.tgenabled)::text
    FROM pg_trigger g JOIN rel r ON r.oid = g.tgrelid JOIN pg_constraint k ON k.oid = g.tgconstraint
    JOIN pg_proc f ON f.oid = g.tgfoid WHERE g.tgisinternal
    GROUP BY r.qname, k.conname, f.proname
  UNION ALL
  SELECT 'rule', schemaname || '.' || tablename || '.' || rulename, to_json(definition)::text
    FROM pg_rules WHERE schemaname IN (SELECT nspname FROM ns)
  UNION ALL
  SELECT 'statistics', ns.nspname || '.' || x.stxname, to_json(pg_get_statisticsobjdef(x.oid))::text
    FROM pg_statistic_ext x JOIN ns ON ns.oid = x.stxnamespace
  UNION ALL
  SELECT 'event_trigger', evtname, json_build_object('event', evtevent, 'enabled', evtenabled,
      'tags', evttags, 'function', evtfoid::regproc::text)::text FROM pg_event_trigger
  UNION ALL
  SELECT 'policy', schemaname || '.' || tablename || '.' || policyname, json_build_object(
      'permissive', permissive, 'roles', roles, 'cmd', cmd, 'using', qual, 'check', with_check)::text
    FROM pg_policies WHERE schemaname IN (SELECT nspname FROM ns)
  UNION ALL
  SELECT 'view', qname, to_json(pg_get_viewdef(oid))::text FROM rel WHERE relkind IN ('v', 'm')
  UNION ALL
  SELECT 'extension', extname, to_json(extversion)::text FROM pg_extension
  UNION ALL
  SELECT 'default_acl', CASE defaclnamespace WHEN 0 THEN '*' ELSE defaclnamespace::regnamespace::text END || '.'
      || defaclrole::regrole::text || '.' || defaclobjtype::text, to_json(defaclacl::text)::text
    FROM pg_default_acl
  UNION ALL
  SELECT 'database_setting', CASE setrole WHEN 0 THEN '*' ELSE setrole::regrole::text END, to_json(setconfig::text)::text
    FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
  UNION ALL
  SELECT 'publication', p.pubname, json_build_object('all_tables', p.puballtables,
      'insert', p.pubinsert, 'update', p.pubupdate, 'delete', p.pubdelete, 'truncate', p.pubtruncate,
      'tables', (SELECT json_agg(t.schemaname || '.' || t.tablename ORDER BY t.schemaname, t.tablename)
                   FROM pg_publication_tables t WHERE t.pubname = p.pubname))::text
    FROM pg_publication p
  UNION ALL
  SELECT 'subscription', subname, '' FROM pg_subscription
    WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  UNION ALL
  SELECT 'foreign_data_wrapper', fdwname, '' FROM pg_foreign_data_wrapper
  UNION ALL
  SELECT 'foreign_server', srvname, '' FROM pg_foreign_server
  UNION ALL
  SELECT 'user_mapping', srvname || '.' || usename, '' FROM pg_user_mappings
  UNION ALL
  SELECT 'cast', castsource::regtype::text || '->' || casttarget::regtype::text,
      json_build_object('function', castfunc::regprocedure::text, 'context', castcontext, 'method', castmethod)::text
    FROM pg_cast
  UNION ALL
  SELECT 'transform', trftype::regtype::text || '.' || (SELECT lanname FROM pg_language WHERE oid = trflang), ''
    FROM pg_transform
  UNION ALL
  SELECT 'access_method', amname, to_json(amtype::text)::text FROM pg_am
  UNION ALL
  SELECT 'language', lanname, json_build_object('trusted', lanpltrusted, 'handler', lanplcallfoid::regproc::text, 'validator', lanvalidator::regproc::text)::text FROM pg_language
  UNION ALL
  SELECT 'large_objects', 'count', count(*)::text FROM pg_largeobject_metadata HAVING count(*) > 0
) objects ORDER BY 1
SQL
)"
psql_in "$migrated" "$catalog" >"$work/$migrated.txt"
psql_in "$fresh" "$catalog" >"$work/$fresh.txt"
node scripts/compare-catalogs.mjs "$work/$migrated.txt" "$work/$fresh.txt" packages/db/sql-only-objects.tsv
