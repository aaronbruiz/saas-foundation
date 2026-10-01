#!/usr/bin/env node
// ADR-0025: production needs both Turnstile keys as Worker secrets. Without them the app refuses
// sign-up, sign-in and password resets (503), so `pnpm run deploy` stops first. Secret values
// can't be read back; the app itself refuses Cloudflare's test keys outside localhost and previews.
// Usage: node scripts/check-turnstile.mjs --deployed
import { execFileSync } from 'node:child_process'

const REQUIRED = ['TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY']

if (!process.argv.includes('--deployed')) {
  console.error('check-turnstile: usage: node scripts/check-turnstile.mjs --deployed')
  process.exit(2)
}
const out = execFileSync('wrangler', ['secret', 'list', '--format', 'json'], {
  cwd: new URL('../apps/web/', import.meta.url),
  encoding: 'utf8',
})
const names = new Set(JSON.parse(out.slice(out.indexOf('['))).map((s) => s.name))
const missing = REQUIRED.filter((name) => !names.has(name))
for (const name of missing)
  console.error(
    `check-turnstile: the production Worker has no ${name} secret; set it first (runbook "Turnstile")`,
  )
if (missing.length) process.exit(1)
console.log('check-turnstile: ok')
