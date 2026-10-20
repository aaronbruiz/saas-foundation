// Proves scripts/compare-catalogs.mjs (check-schema-sql.sh's comparison) separates registered
// SQL-only objects from drift, failing closed: an unexpected function, trigger or archive table, a
// missing or changed registered object, and any difference in a Drizzle-managed table, index or
// constraint all fail. Catalog lines have check-schema-sql.sh's shape. Run by `pnpm lint`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const script = new URL('compare-catalogs.mjs', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'compare-catalogs-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const line = (kind, name, detail) => `${kind}\t${JSON.stringify(name)}\t${detail}`

// Drizzle-managed objects, identical on both sides unless a test changes them.
const MODELED = [
  line('schema', 'public', ''),
  line('relation', 'public.project', '{"kind" : "r", "rls" : false}'),
  line('column', 'public.project.name', '{"type" : "text", "not_null" : true}'),
  line('constraint', 'public.project.project_pkey', '"PRIMARY KEY (id)"'),
  line(
    'index',
    'public.project_organization_id_idx',
    '"CREATE INDEX project_organization_id_idx ON public.project USING btree (organization_id)"',
  ),
]
// SQL-only objects the custom migrations create on purpose.
const DEFINER =
  "CREATE OR REPLACE FUNCTION public.f(p text)\\n SECURITY DEFINER\\n SET search_path TO 'pg_catalog', 'pg_temp'"
const SQL_ONLY = [
  line('schema', 'archive', ''),
  line('relation', 'archive.deleted_row', '{"kind" : "r", "rls" : false}'),
  line('function', 'public.f(p text)', `"${DEFINER}"`),
  line(
    'trigger',
    'public.project.archive_delete',
    '{"def" : "CREATE TRIGGER archive_delete AFTER DELETE ON public.project FOR EACH ROW EXECUTE FUNCTION archive.capture_delete()", "enabled" : "O"}',
  ),
]
const registryOf = (lines) =>
  `# comment\n${lines
    .map((l) => {
      const [kind, name, detail] = l.split('\t')
      return `${kind}\t${JSON.parse(name)}\t${sha256(detail)}`
    })
    .join('\n')}\n`

let n = 0
function run({
  migrated = [...MODELED, ...SQL_ONLY],
  fresh = MODELED,
  registry = registryOf(SQL_ONLY),
} = {}) {
  const files = ['migrated', 'fresh', 'registry'].map((f) => join(dir, `${n}-${f}`))
  n++
  writeFileSync(files[0], `${migrated.join('\n')}\n`)
  writeFileSync(files[1], `${fresh.join('\n')}\n`)
  writeFileSync(files[2], registry)
  return spawnSync(process.execPath, [script, ...files], { encoding: 'utf8' })
}
const passes = (r) => assert.equal(r.status, 0, r.stderr)
const fails = (r, fragment, status = 1) => {
  assert.equal(r.status, status, `expected exit ${status}; stderr: ${r.stderr}`)
  assert.match(r.stderr, fragment)
}
const replace = (lines, i, l) => lines.map((x, j) => (j === i ? l : x))

test('the migrations plus exactly the registered SQL-only objects pass', () => {
  passes(run())
})

test('an unexpected function fails, even next to a registered one in the same schema', () => {
  const extra = line(
    'function',
    'public.g()',
    '"CREATE OR REPLACE FUNCTION public.g() SECURITY DEFINER"',
  )
  fails(
    run({ migrated: [...MODELED, ...SQL_ONLY, extra] }),
    /only in the migrations: function public\.g\(\)/,
  )
})

test('an overload of a registered function is a different object and fails', () => {
  const overload = line('function', 'public.f(p character varying)', `"${DEFINER}"`)
  fails(
    run({ migrated: [...MODELED, ...SQL_ONLY, overload] }),
    /only in the migrations: function public\.f\(p character varying\)/,
  )
})

test('an unexpected trigger fails, even with a registered trigger on the same table', () => {
  const extra = line(
    'trigger',
    'public.project.audit_insert',
    '{"def" : "CREATE TRIGGER audit_insert AFTER INSERT ON public.project FOR EACH ROW EXECUTE FUNCTION archive.audit_auth()", "enabled" : "O"}',
  )
  fails(
    run({ migrated: [...MODELED, ...SQL_ONLY, extra] }),
    /only in the migrations: trigger public\.project\.audit_insert/,
  )
})

test('an unexpected table inside the registered archive schema fails', () => {
  const extra = [
    line('relation', 'archive.copy', '{"kind" : "r", "rls" : false}'),
    line('column', 'archive.deleted_row.secret', '{"type" : "text"}'),
  ]
  const r = run({ migrated: [...MODELED, ...SQL_ONLY, ...extra] })
  fails(r, /only in the migrations: relation archive\.copy/)
  assert.match(r.stderr, /only in the migrations: column archive\.deleted_row\.secret/)
})

test('a missing registered object fails', () => {
  const migrated = [...MODELED, ...SQL_ONLY.filter((l) => !l.startsWith('trigger'))]
  fails(
    run({ migrated }),
    /registered SQL-only object is missing: trigger public\.project\.archive_delete/,
  )
})

test('a registered object whose definition changed fails (a definer losing its search_path)', () => {
  const weakened = line(
    'function',
    'public.f(p text)',
    '"CREATE OR REPLACE FUNCTION public.f(p text)\\n SECURITY DEFINER"',
  )
  const migrated = [...MODELED, ...replace(SQL_ONLY, 2, weakened)]
  fails(
    run({ migrated }),
    /registered SQL-only object changed: function public\.f\(p text\) \(now [0-9a-f]{64}/,
  )
})

test('a disabled registered trigger fails', () => {
  const disabled = SQL_ONLY[3].replace('"enabled" : "O"', '"enabled" : "D"')
  fails(
    run({ migrated: [...MODELED, ...replace(SQL_ONLY, 3, disabled)] }),
    /registered SQL-only object changed: trigger public\.project\.archive_delete/,
  )
})

test('a registered object the Drizzle schema also builds fails (it is not SQL-only)', () => {
  fails(
    run({ fresh: [...MODELED, SQL_ONLY[1]] }),
    /built by the Drizzle schema, so it isn't SQL-only: relation archive\.deleted_row/,
  )
})

test('a Drizzle-managed table, index or constraint that differs fails', () => {
  const missingTable = MODELED.filter((l) => !l.startsWith('relation'))
  fails(
    run({ migrated: [...missingTable, ...SQL_ONLY] }),
    /only in the schema: relation public\.project/,
  )
  const otherIndex = line(
    'index',
    'public.project_organization_id_idx',
    '"CREATE INDEX project_organization_id_idx ON public.project USING btree (name)"',
  )
  fails(
    run({ migrated: [...replace(MODELED, 4, otherIndex), ...SQL_ONLY] }),
    /differs: index public\.project_organization_id_idx/,
  )
  const otherConstraint = line('constraint', 'public.project.project_pkey', '"PRIMARY KEY (name)"')
  fails(
    run({ migrated: [...replace(MODELED, 3, otherConstraint), ...SQL_ONLY] }),
    /differs: constraint public\.project\.project_pkey/,
  )
  const extraIndex = line(
    'index',
    'public.project_name_idx',
    '"CREATE INDEX project_name_idx ON public.project USING btree (name)"',
  )
  fails(
    run({ migrated: [...MODELED, extraIndex, ...SQL_ONLY] }),
    /only in the migrations: index public\.project_name_idx/,
  )
})

test('a Drizzle-managed object registered as SQL-only fails instead of being exempted', () => {
  fails(
    run({ registry: registryOf([...SQL_ONLY, MODELED[1]]) }),
    /built by the Drizzle schema, so it isn't SQL-only: relation public\.project/,
  )
})

test('a malformed or duplicate registry entry, or an unreadable or duplicate catalog line, is an error', () => {
  fails(
    run({ registry: 'function\tpublic.f(p text)\tnot-a-hash\n' }),
    /expected <kind>\\t<name>\\t<sha256>/,
    2,
  )
  fails(
    run({ registry: 'function public.f(p text) ' + 'a'.repeat(64) + '\n' }),
    /expected <kind>\\t<name>\\t<sha256>/,
    2,
  )
  const twice = registryOf(SQL_ONLY) + registryOf([SQL_ONLY[0]]).split('\n')[1] + '\n'
  fails(run({ registry: twice }), /schema archive is registered twice/, 2)
  fails(
    run({ migrated: [...MODELED, ...SQL_ONLY, 'function\tpublic.h()'] }),
    /unreadable catalog line/,
    2,
  )
  fails(
    run({ migrated: [...MODELED, ...SQL_ONLY, 'function\tpublic.h()\t""'] }),
    /unreadable catalog line/,
    2,
  )
  fails(
    run({ migrated: [...MODELED, ...SQL_ONLY, SQL_ONLY[2]] }),
    /function public\.f\(p text\) appears twice/,
    2,
  )
})

test('only kinds whose whole definition is compared can be registered', () => {
  for (const kind of [
    'ts_config',
    'opfamily',
    'opclass',
    'operator',
    'type',
    'conversion',
    'foreign_server',
  ]) {
    fails(
      run({ registry: `${kind}\tpublic.x\t${'a'.repeat(64)}\n` }),
      new RegExp(`${kind} objects can't be registered`),
      2,
    )
  }
})
