// Validates and patches the Worker config of an untrusted build artifact (ADR-0013 step 3).
// The artifact's `dist/server/wrangler.json` is data from PR code, so it's checked against what the
// committed config can produce before `wrangler preview --config` gets it:
//   - name and account are the committed ones; no build command; no_bundle;
//   - main and assets stay inside the artifact's dist/;
//   - the only binding is the Hyperdrive DB, with the fail-closed previews sentinel;
//   - every other key is either known-harmless or empty (new wrangler keys must stay empty).
// Then it points both DB ids at the PR's own Hyperdrive config, turns preview URLs on, and drops
// routes and the build-machine redirect paths. Writes the file in place.
// Usage: prepare-config.mjs <dist/server/wrangler.json> <pinned-account-id> [<hyperdrive-id>]
// Without a Hyperdrive id it only validates.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const WORKER_NAME = 'saas-foundation' // `name` in the committed apps/web/wrangler.jsonc
const PREVIEWS_SENTINEL = '0'.repeat(32)
const hex32 = /^[0-9a-f]{32}$/

const [file, accountId, hyperdriveId] = process.argv.slice(2)
const errors = []
const check = (ok, msg) => ok || errors.push(msg)
if (
  !file ||
  !hex32.test(accountId ?? '') ||
  (hyperdriveId !== undefined && !hex32.test(hyperdriveId))
) {
  console.error('usage: prepare-config.mjs <wrangler.json> <account-id> [<hyperdrive-id>]')
  process.exit(1)
}

const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isEmpty = (v) =>
  v === undefined ||
  v === null ||
  (Array.isArray(v) && v.length === 0) ||
  (isPlain(v) && Object.values(v).every(isEmpty))
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const serverDir = dirname(resolve(file))
const distDir = dirname(serverDir)
const inside = (base, p) => {
  const rel = relative(base, p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
// A path from the config must resolve to a real (non-symlinked) location inside dist/.
const insideDist = (p, kind) => {
  if (typeof p !== 'string' || isAbsolute(p)) return false
  const abs = resolve(serverDir, p)
  const st = lstatSync(abs, { throwIfNoEntry: false })
  if (!st || (kind === 'file' ? !st.isFile() : !st.isDirectory())) return false
  return inside(realpathSync(distDir), realpathSync(abs))
}

const cfg = JSON.parse(readFileSync(file, 'utf8'))
check(isPlain(cfg), 'config is not an object')

// Keys with a specific rule. Everything not listed here must be empty.
const rules = {
  // Written by the build machine (redirected-config bookkeeping); dropped below.
  configPath: () => true,
  userConfigPath: () => true,
  topLevelName: (v) => v === WORKER_NAME,
  definedEnvironments: (v) => sameJson(v, []),
  name: (v) => v === WORKER_NAME,
  account_id: (v) => v === accountId,
  main: (v) => insideDist(v, 'file'),
  compatibility_date: (v) => typeof v === 'string',
  compatibility_flags: isStringArray,
  jsx_factory: (v) => typeof v === 'string',
  jsx_fragment: (v) => typeof v === 'string',
  rules: (v) =>
    Array.isArray(v) &&
    v.every((r) => isPlain(r) && typeof r.type === 'string' && isStringArray(r.globs)),
  routes: () => true, // dropped below: a preview never takes routes
  // Static assets only: no ASSETS binding (a binding needs an ADR like any other).
  assets: (v) =>
    isPlain(v) &&
    Object.keys(v).every((k) =>
      ['directory', 'html_handling', 'not_found_handling', 'run_worker_first'].includes(k),
    ) &&
    insideDist(v.directory, 'dir'),
  placement: isPlain,
  workers_dev: (v) => v === false,
  preview_urls: (v) => v === false,
  vars: (v) => isPlain(v) && Object.values(v).every((x) => typeof x === 'string'),
  hyperdrive: (v) =>
    Array.isArray(v) &&
    v.length === 1 &&
    v[0].binding === 'DB' &&
    hex32.test(v[0].id ?? '') &&
    Object.keys(v[0]).every((k) => ['binding', 'id', 'localConnectionString'].includes(k)),
  previews: (v) => sameJson(v, { hyperdrive: [{ binding: 'DB', id: PREVIEWS_SENTINEL }] }),
  upload_source_maps: (v) => typeof v === 'boolean',
  observability: isPlain,
  python_modules: isPlain,
  dev: isPlain,
  no_bundle: (v) => v === true,
}
for (const [key, value] of Object.entries(cfg)) {
  const rule = rules[key]
  if (rule) check(rule(value), `"${key}" has an unexpected value`)
  else check(isEmpty(value), `"${key}" must be empty (only the Hyperdrive DB binding is allowed)`)
}
for (const key of ['name', 'account_id', 'main', 'assets', 'hyperdrive', 'previews', 'no_bundle'])
  check(key in cfg, `"${key}" is missing`)

if (errors.length) {
  console.error(`${file}: refusing this artifact's Worker config (ADR-0013):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
if (hyperdriveId === undefined) {
  console.error('artifact config OK')
  process.exit(0)
}

for (const key of ['configPath', 'userConfigPath', 'topLevelName', 'definedEnvironments', 'routes'])
  delete cfg[key]
cfg.preview_urls = true
cfg.hyperdrive = [{ binding: 'DB', id: hyperdriveId }]
cfg.previews = { hyperdrive: [{ binding: 'DB', id: hyperdriveId }] }
writeFileSync(file, JSON.stringify(cfg, null, 2))
console.error(`artifact config OK; DB -> ${hyperdriveId}`)
