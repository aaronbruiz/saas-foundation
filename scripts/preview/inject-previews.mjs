// Points the committed fail-closed `previews.hyperdrive` DB sentinel at the PR's own Hyperdrive
// config (ADR-0011). Runs in CI before the build; the result is never committed.
// Idempotent: replaces whatever id the previews DB binding currently has, so re-runs work.
import { readFileSync, writeFileSync } from 'node:fs'

const [file, hyperdriveId] = process.argv.slice(2)
if (!file || !/^[0-9a-f]{32}$/.test(hyperdriveId ?? '')) {
  console.error('usage: inject-previews.mjs <wrangler.jsonc> <hyperdrive-id>')
  process.exit(1)
}
const src = readFileSync(file, 'utf8')
const at = src.indexOf('"previews"')
if (at === -1) {
  console.error(`${file} has no "previews" block; expected the fail-closed sentinel (ADR-0011)`)
  process.exit(1)
}
const binding = /("binding":\s*"DB",\s*"id":\s*")[0-9a-f]{32}(")/
const head = src.slice(0, at)
const tail = src.slice(at)
if (!binding.test(tail)) {
  console.error(`${file}: no DB binding with a 32-hex id inside "previews"`)
  process.exit(1)
}
writeFileSync(file, head + tail.replace(binding, `$1${hyperdriveId}$2`))
console.error(`previews.hyperdrive DB -> ${hyperdriveId}`)
