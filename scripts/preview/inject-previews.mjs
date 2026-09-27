// Adds the per-PR `previews.hyperdrive` override to the workspace wrangler.jsonc (ADR-0011).
// Runs in CI only; the result is never committed. Refuses if a `previews` block already exists.
import { readFileSync, writeFileSync } from 'node:fs'

const [file, hyperdriveId] = process.argv.slice(2)
if (!file || !/^[0-9a-f]{32}$/.test(hyperdriveId ?? '')) {
  console.error('usage: inject-previews.mjs <wrangler.jsonc> <hyperdrive-id>')
  process.exit(1)
}
const src = readFileSync(file, 'utf8').trimEnd()
if (src.includes('"previews"')) {
  console.error(`${file} already has a "previews" block; refusing to inject`)
  process.exit(1)
}
if (!src.endsWith('}')) {
  console.error(`${file} does not end with "}"`)
  process.exit(1)
}
const block = `  "previews": {\n    "hyperdrive": [{ "binding": "DB", "id": "${hyperdriveId}" }],\n  },\n}\n`
writeFileSync(file, src.slice(0, -1).trimEnd() + '\n' + block)
console.error(`injected previews.hyperdrive = ${hyperdriveId}`)
