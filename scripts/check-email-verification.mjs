#!/usr/bin/env node
// ADR-0016: only PR previews may run with EMAIL_VERIFICATION=off (scripts/preview/lib.sh passes it
// with --var). Fails when
//   - apps/web/wrangler.jsonc sets EMAIL_VERIFICATION (any `vars` block: it would reach production);
//   - with --deployed (run by `pnpm run deploy`), the production Worker has an EMAIL_VERIFICATION
//     secret. Plain-text dashboard vars are replaced by `wrangler deploy`; secrets persist.
// The app also ignores `off` outside a workers.dev URL; this catches the mistake before it ships.
// Usage: node scripts/check-email-verification.mjs [--deployed]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const NAME = 'EMAIL_VERIFICATION'
const CONFIG = new URL('../apps/web/wrangler.jsonc', import.meta.url)
const errors = []

if (new RegExp(`"${NAME}"\\s*:`).test(readFileSync(CONFIG, 'utf8')))
  errors.push(`apps/web/wrangler.jsonc sets ${NAME}; only previews may turn it off (via --var)`)

if (process.argv.includes('--deployed')) {
  const out = execFileSync('wrangler', ['secret', 'list', '--format', 'json'], {
    cwd: new URL('../apps/web/', import.meta.url),
    encoding: 'utf8',
  })
  const secrets = JSON.parse(out.slice(out.indexOf('[')))
  if (secrets.some((s) => s.name === NAME))
    errors.push(
      `the production Worker has a ${NAME} secret; remove it: wrangler secret delete ${NAME}`,
    )
}

for (const e of errors) console.error(`check-email-verification: ${e}`)
if (errors.length) process.exit(1)
console.log('check-email-verification: ok')
