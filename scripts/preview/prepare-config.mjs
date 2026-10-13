// Validates and patches the Worker config of an untrusted build artifact (ADR-0013 step 3).
// The artifact's `dist/server/wrangler.json` is data from PR code, so it's checked against what the
// committed config can produce before `wrangler preview --config` gets it:
//   - name and account are the committed ones; no build command; no_bundle;
//   - main stays inside dist/server; assets are exactly dist/client (never the server bundle);
//   - no vars (previews set theirs with --var);
//   - the only binding is the Hyperdrive DB, with the fail-closed previews sentinel; the email
//     binding is accepted only exactly as committed, and then removed (previews never send email,
//     ADR-0024);
//   - every other key is either known-harmless or empty (new wrangler keys must stay empty).
// Then it points both DB ids at the PR's own Hyperdrive config, turns preview URLs on, turns source
// map upload off (wrangler would follow a bundle's sourceMappingURL to files outside the artifact),
// and drops routes, the email binding and the build-machine redirect paths. Writes the file in place.
// Usage: prepare-config.mjs <dist/server/wrangler.json> <pinned-account-id> [<hyperdrive-id> <production-hyperdrive-id>]
// Without a Hyperdrive id it only validates. The production id is refused as a target (ADR-0021).
// Production releases (ADR-0029): `prepare-config.mjs <wrangler.json> <account-id> --production
// <production-hyperdrive-id>` applies the same rules to a release artifact, requires the DB binding
// to be the production config, keeps the committed email binding, turns source map upload off (as
// for previews; the build emits no source maps today) and drops the build-machine bookkeeping keys.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const WORKER_NAME = 'saas-foundation' // `name` in the committed apps/web/wrangler.jsonc
const PREVIEWS_SENTINEL = '0'.repeat(32)
// `send_email` in the committed apps/web/wrangler.jsonc (ADR-0024). Removed from every preview.
const COMMITTED_SEND_EMAIL = [
  { name: 'EMAIL', allowed_sender_addresses: ['no-reply@mail.aaronlabr.dev'] },
]
const hex32 = /^[0-9a-f]{32}$/

const args = process.argv.slice(2)
const production = args[2] === '--production'
const [file, accountId] = args
const [hyperdriveId, productionId] = production ? [undefined, args[3]] : args.slice(2)
const errors = []
const check = (ok, msg) => ok || errors.push(msg)
if (
  !file ||
  !hex32.test(accountId ?? '') ||
  (production && (!hex32.test(productionId ?? '') || args.length !== 4)) ||
  (!production &&
    hyperdriveId !== undefined &&
    (!hex32.test(hyperdriveId) || !hex32.test(productionId ?? '') || hyperdriveId === productionId))
) {
  console.error(
    'usage: prepare-config.mjs <wrangler.json> <account-id> [<hyperdrive-id> <production-hyperdrive-id>] (never the production id)',
  )
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
// A relative path from the config, resolved to its real location (null if missing or wrong kind).
const realPath = (p, kind) => {
  if (typeof p !== 'string' || isAbsolute(p)) return null
  const abs = resolve(serverDir, p)
  const st = lstatSync(abs, { throwIfNoEntry: false })
  if (!st || (kind === 'file' ? !st.isFile() : !st.isDirectory())) return null
  return realpathSync(abs)
}
const inside = (base, p) => {
  const rel = p === null ? '' : relative(realpathSync(base), p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
const clientDir = realPath('../client', 'dir') // dist/client
const isClientDir = (p) => clientDir !== null && realPath(p, 'dir') === clientDir

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
  main: (v) => inside(serverDir, realPath(v, 'file')),
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
    isClientDir(v.directory) &&
    Object.entries(v).every(
      ([k, x]) =>
        k === 'directory' ||
        (['html_handling', 'not_found_handling'].includes(k) && typeof x === 'string') ||
        (k === 'run_worker_first' && (typeof x === 'boolean' || isStringArray(x))),
    ),
  placement: isPlain,
  workers_dev: (v) => v === false,
  preview_urls: (v) => v === false,
  hyperdrive: (v) =>
    Array.isArray(v) &&
    v.length === 1 &&
    v[0].binding === 'DB' &&
    hex32.test(v[0].id ?? '') &&
    Object.keys(v[0]).every((k) => ['binding', 'id', 'localConnectionString'].includes(k)),
  previews: (v) => sameJson(v, { hyperdrive: [{ binding: 'DB', id: PREVIEWS_SENTINEL }] }),
  send_email: (v) => sameJson(v, COMMITTED_SEND_EMAIL),
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

if (production) {
  check(
    cfg.hyperdrive?.[0]?.id === productionId,
    'the DB binding is not the production Hyperdrive config',
  )
  check(
    sameJson(cfg.send_email, COMMITTED_SEND_EMAIL),
    'the email binding differs from the committed one',
  )
}

if (errors.length) {
  console.error(`${file}: refusing this artifact's Worker config (ADR-0013):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
if (production) {
  for (const key of ['configPath', 'userConfigPath', 'topLevelName', 'definedEnvironments'])
    delete cfg[key]
  // As for previews: wrangler would follow a bundle's sourceMappingURL to files outside the artifact.
  cfg.upload_source_maps = false
  writeFileSync(file, JSON.stringify(cfg, null, 2))
  console.error('release artifact config OK (production)')
  process.exit(0)
}
if (hyperdriveId === undefined) {
  console.error('artifact config OK')
  process.exit(0)
}

for (const key of [
  'configPath',
  'userConfigPath',
  'topLevelName',
  'definedEnvironments',
  'routes',
  'send_email',
])
  delete cfg[key]
cfg.preview_urls = true
cfg.upload_source_maps = false
cfg.hyperdrive = [{ binding: 'DB', id: hyperdriveId }]
cfg.previews = { hyperdrive: [{ binding: 'DB', id: hyperdriveId }] }
writeFileSync(file, JSON.stringify(cfg, null, 2))
console.error(`artifact config OK; DB -> ${hyperdriveId}`)
