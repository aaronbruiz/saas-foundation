#!/usr/bin/env bash
# AGENTS.md invariant 10: the migrations' SQL builds exactly the schema in packages/db/src/schema.
# Migrates one fresh database, pushes the TypeScript schema into another, and compares the two
# catalogs. scripts/check-migrations.mjs compares snapshots, not SQL, so a migration whose SQL omits
# something its snapshot declares (an index, a constraint, a default) only shows up here.
# The comparison is one line per object, sorted by name (a migration appends a new column at the
# end while push creates it in schema order, so column order is ignored), with every definition
# JSON-escaped (a multi-line default stays on its line, so nothing can hide in it). It covers
# schemas, relations and composite types (kind, RLS, options such as a view's security_invoker,
# replica identity), columns (type, nullability, default, identity, generated, collation, storage,
# compression, statistics target, options),
# constraints, indexes, every standalone type (enums, domains, ranges…), collations, sequences,
# functions and aggregates, triggers (with firing state, including the internal ones enforcing
# foreign keys), rules, statistics, policies, views, event triggers, extensions, and by name
# operators, operator classes and families, conversions and text-search objects, outside
# drizzle's own `drizzle` schema (only the migrated database has it). Owners and privileges are
# left out: grants are checked by
# apps/app/test/database-role.test.ts. Uses the Postgres container serving localhost:5432
# (POSTGRES_CONTAINER, default: the one publishing that port, which also works from a worktree)
# and creates and drops two databases in it. Run by ci.yml and `pnpm db:check`.
set -euo pipefail
cd "$(dirname "$0")/.."

container="${POSTGRES_CONTAINER:-$(docker ps -q --filter publish=5432)}"
[ -n "$container" ] || { echo "check-schema-sql: no Postgres container (pnpm db:up)" >&2; exit 2; }
url=postgres://app:app@localhost:5432
migrated=schema_check_migrated
pushed=schema_check_pushed
work="$(mktemp -d)"

psql_in() {
  docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$container" \
    psql -qAtX -v ON_ERROR_STOP=1 -U app -d "$1" -c "$2"
}
drop() { for db in "$migrated" "$pushed"; do psql_in app "DROP DATABASE IF EXISTS $db" >/dev/null; done; }
cleanup() { drop || true; rm -rf "$work"; }
trap cleanup EXIT

drop
for db in "$migrated" "$pushed"; do psql_in app "CREATE DATABASE $db" >/dev/null; done
kit() {
  DATABASE_URL="$url/$1" pnpm --filter @saas-foundation/db exec drizzle-kit "${@:2}" </dev/null >"$work/$1.log" 2>&1 \
    || { cat "$work/$1.log" >&2; echo "check-schema-sql: drizzle-kit ${*:2} failed" >&2; exit 1; }
}
kit "$migrated" migrate
kit "$pushed" push --force

catalog="$(cat <<'SQL'
WITH ns AS (
  SELECT oid, nspname FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'drizzle')
    AND nspname NOT LIKE 'pg\_temp\_%' AND nspname NOT LIKE 'pg\_toast\_temp\_%'
), rel AS (
  SELECT c.*, ns.nspname || '.' || c.relname AS qname FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
)
SELECT kind || ' ' || name || ' ' || detail FROM (
  SELECT 'schema' AS kind, nspname AS name, '' AS detail FROM ns
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
  UNION ALL
  SELECT 'type', ns.nspname || '.' || t.typname, json_build_object('kind', t.typtype,
      'labels', (SELECT json_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = t.oid),
      'base', format_type(t.typbasetype, t.typtypmod), 'not_null', t.typnotnull, 'default', t.typdefault)::text
    FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
    -- every standalone type (enum, domain, base, range, multirange, pseudo); a relation's row type
    -- and implicit array types come with the relation or type they belong to
    WHERE t.typrelid = 0 AND NOT (t.typcategory = 'A' AND t.typelem <> 0)
  UNION ALL
  SELECT 'collation', ns.nspname || '.' || c.collname, json_build_object('provider', c.collprovider,
      'deterministic', c.collisdeterministic, 'collate', c.collcollate, 'ctype', c.collctype,
      'locale', c.colllocale, 'rules', c.collicurules)::text
    FROM pg_collation c JOIN ns ON ns.oid = c.collnamespace
  UNION ALL
  -- Any other namespaced object a custom migration could add, by name.
  SELECT 'operator', ns.nspname || '.' || o.oprname || '(' || o.oprleft::regtype || ',' || o.oprright::regtype || ')',
      json_build_object('function', o.oprcode::regproc::text)::text
    FROM pg_operator o JOIN ns ON ns.oid = o.oprnamespace
  UNION ALL
  SELECT 'opclass', ns.nspname || '.' || c.opcname, '' FROM pg_opclass c JOIN ns ON ns.oid = c.opcnamespace
  UNION ALL
  SELECT 'opfamily', ns.nspname || '.' || f.opfname, '' FROM pg_opfamily f JOIN ns ON ns.oid = f.opfnamespace
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
  SELECT 'extension', extname, extversion FROM pg_extension
) objects ORDER BY 1
SQL
)"
psql_in "$migrated" "$catalog" >"$work/$migrated.txt"
psql_in "$pushed" "$catalog" >"$work/$pushed.txt"
if ! diff -u --label "migrations (drizzle-kit migrate)" --label "schema (drizzle-kit push)" "$work/$migrated.txt" "$work/$pushed.txt"; then
  echo "check-schema-sql: the migrations' SQL doesn't build packages/db/src/schema (diff above); fix it with a new migration" >&2
  exit 1
fi
echo "check-schema-sql: migrations build the schema ($(wc -l <"$work/$migrated.txt") catalog objects compared)"
