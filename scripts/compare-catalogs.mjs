// The comparison step of scripts/check-schema-sql.sh, without a database (tested by
// scripts/compare-catalogs.test.mjs). Inputs are its catalog dumps, one object per line:
// `<kind>\t<name as a JSON string>\t<definition>`, and the registry of SQL-only objects
// (packages/db/sql-only-objects.tsv): objects that custom migrations create on purpose and the
// Drizzle schema can't express (the archive schema, triggers, functions). Fails closed:
//   - every registered object exists in the migrated database, with exactly the registered
//     definition (SHA-256 of its definition line), and isn't built by the Drizzle schema;
//   - everything else is compared exactly: an object only in the migrations, only in the schema,
//     or defined differently fails, whatever its kind or schema (no kind or schema is skipped);
//   - an unreadable line, a duplicate object or a malformed registry entry is an error.
// Usage: node scripts/compare-catalogs.mjs <migrated.txt> <fresh.txt> <registry.tsv>
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

function catalog(file) {
  const objects = new Map()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue
    const [kind, name, ...rest] = line.split('\t')
    let parsed
    try {
      parsed = JSON.parse(name ?? '')
    } catch {
      parsed = undefined
    }
    if (!/^[a-z_]+$/.test(kind) || typeof parsed !== 'string' || rest.length === 0)
      throw new Error(`${file}: unreadable catalog line ${JSON.stringify(line)}`)
    const key = `${kind} ${parsed}`
    if (objects.has(key)) throw new Error(`${file}: ${key} appears twice`)
    objects.set(key, rest.join('\t'))
  }
  return objects
}

function registry(file) {
  const entries = new Map()
  for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (line === '' || line.startsWith('#')) continue
    const fields = line.split('\t')
    if (
      fields.length !== 3 ||
      !/^[a-z_]+$/.test(fields[0]) ||
      !fields[1] ||
      !/^[0-9a-f]{64}$/.test(fields[2])
    )
      throw new Error(
        `${file}:${i + 1}: expected <kind>\\t<name>\\t<sha256>, got ${JSON.stringify(line)}`,
      )
    const key = `${fields[0]} ${fields[1]}`
    if (entries.has(key)) throw new Error(`${file}:${i + 1}: ${key} is registered twice`)
    entries.set(key, fields[2])
  }
  return entries
}

/** Problems found, one line each (empty: the migrations build the schema plus the registry). */
export function compare(migrated, fresh, registered) {
  const problems = []
  for (const [key, hash] of registered) {
    if (!migrated.has(key)) problems.push(`registered SQL-only object is missing: ${key}`)
    else if (fresh.has(key))
      problems.push(
        `registered object is built by the Drizzle schema, so it isn't SQL-only: ${key}`,
      )
    else if (sha256(migrated.get(key)) !== hash)
      problems.push(
        `registered SQL-only object changed: ${key} (now ${sha256(migrated.get(key))}; review the migration, then update the registry)`,
      )
  }
  const keys = [...new Set([...migrated.keys(), ...fresh.keys()])].sort()
  for (const key of keys) {
    if (registered.has(key)) continue
    const m = migrated.get(key)
    const f = fresh.get(key)
    if (f === undefined)
      problems.push(
        `only in the migrations: ${key} ${m}\n    if intentional, register: ${key.replace(' ', '\t')}\t${sha256(m)}`,
      )
    else if (m === undefined) problems.push(`only in the schema: ${key} ${f}`)
    else if (m !== f) problems.push(`differs: ${key}\n    migrations: ${m}\n    schema:     ${f}`)
  }
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [migratedFile, freshFile, registryFile] = process.argv.slice(2)
  try {
    const migrated = catalog(migratedFile)
    const fresh = catalog(freshFile)
    const registered = registry(registryFile)
    const problems = compare(migrated, fresh, registered)
    if (problems.length > 0) {
      for (const p of problems) console.error(p)
      console.error(
        "check-schema-sql: the migrations' SQL doesn't build packages/db/src/schema plus the registered SQL-only objects (above)",
      )
      process.exit(1)
    }
    console.log(
      `check-schema-sql: migrations build the schema (${fresh.size} objects compared, ${registered.size} registered SQL-only objects verified)`,
    )
  } catch (e) {
    console.error(`check-schema-sql: ${e.message}`)
    process.exit(2)
  }
}
