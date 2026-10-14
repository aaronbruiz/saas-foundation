#!/usr/bin/env node
// Checks the production Worker's configuration before a deploy (`pnpm run deploy`, release preflight).
// Fails when
//   - apps/app/wrangler.jsonc sets EMAIL_VERIFICATION (ADR-0016: any `vars` block would reach
//     production; only previews may turn it off, with --var from scripts/preview/lib.sh);
//   - with --deployed, the production Worker has an EMAIL_VERIFICATION secret (secrets persist
//     across deploys; the app also ignores `off` outside a workers.dev URL), or lacks either
//     Turnstile key (ADR-0025: without them the app refuses sign-up, sign-in and password resets).
// Secret values can't be read back, only names. Run from CI without --deployed (config only).
// Usage: node scripts/check-secrets.mjs [--deployed]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CONFIG = new URL('../apps/app/wrangler.jsonc', import.meta.url)
const errors = []

if (/"EMAIL_VERIFICATION"\s*:/.test(readFileSync(CONFIG, 'utf8')))
  errors.push(
    'apps/app/wrangler.jsonc sets EMAIL_VERIFICATION; only previews may turn it off (via --var)',
  )

if (process.argv.includes('--deployed')) {
  const out = execFileSync('wrangler', ['secret', 'list', '--format', 'json'], {
    cwd: new URL('../apps/app/', import.meta.url),
    encoding: 'utf8',
  })
  const names = new Set(JSON.parse(out.slice(out.indexOf('['))).map((s) => s.name))
  if (names.has('EMAIL_VERIFICATION'))
    errors.push(
      'the production Worker has an EMAIL_VERIFICATION secret; remove it: wrangler secret delete EMAIL_VERIFICATION',
    )
  for (const name of ['TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY'])
    if (!names.has(name))
      errors.push(`the production Worker has no ${name} secret; set it first (runbook "Turnstile")`)
}

for (const e of errors) console.error(`check-secrets: ${e}`)
if (errors.length) process.exit(1)
console.log('check-secrets: ok')
