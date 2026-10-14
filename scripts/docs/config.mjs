#!/usr/bin/env node
// Derives the Wrangler config for a docs deploy (ADR-0028) from `main`'s apps/docs/wrangler.jsonc:
// only its assets-only keys are copied (an allowlist, so nothing else can reach a deploy), and the
// assets directory becomes the given site directory. `--preview` drops the routes (a Preview never
// gets the custom domain) and adds the empty `previews` block that `wrangler preview` requires.
// Prints the config as JSON.
// Usage: node scripts/docs/config.mjs <apps/docs/wrangler.jsonc> <absolute site dir> [--preview]
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const [configPath, siteDir, flag] = process.argv.slice(2)
if (!configPath || !siteDir || !isAbsolute(siteDir) || (flag && flag !== '--preview')) {
  console.error('usage: config.mjs <wrangler.jsonc> <absolute site dir> [--preview]')
  process.exit(1)
}

// JSONC → JSON as in scripts/check-bindings.mjs: drop comments and trailing commas, leaving string
// contents untouched.
const text = readFileSync(configPath, 'utf8')
  .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '')
  .replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (m, str, end) => str ?? end)
const source = JSON.parse(text)

const config = {
  name: source.name,
  compatibility_date: source.compatibility_date,
  workers_dev: false,
  preview_urls: false,
  assets: {
    directory: siteDir,
    not_found_handling: source.assets?.not_found_handling,
    html_handling: source.assets?.html_handling,
  },
}
if (flag === '--preview') config.previews = {}
else config.routes = source.routes
console.log(JSON.stringify(config, null, 2))
