#!/usr/bin/env node
// AGENTS.md invariant 14: a new Cloudflare binding, product or Worker needs a new ADR, and every
// storage binding needs a `previews` override. Compares apps/web/wrangler.jsonc in the working tree
// with the merge base of <base-ref> (CI: the PR merge commit's base parent) and fails when
//   - any other Wrangler config exists (a second Worker), or the config uses named environments;
//   - a binding/product/Worker-name id is new (including under `previews`) and no ADR added since
//     the base mentions its name, or
//   - a storage binding (STORAGE) has no `previews` entry with the same binding name. Other data
//     bindings get no automatic check: their ADR must state how previews stay isolated.
// Usage: node scripts/check-bindings.mjs [base-ref]   (default origin/main)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CONFIG = 'apps/web/wrangler.jsonc'
const STORAGE = ['kv_namespaces', 'r2_buckets', 'd1_databases', 'hyperdrive', 'vectorize']
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

// JSONC → JSON: drop comments and trailing commas, leaving string contents untouched.
function parseJsonc(text) {
  const out = text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m, str) => str ?? '',
  )
  return JSON.parse(out.replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (m, str, end) => str ?? end))
}

// Ids like `worker:saas-foundation`, `hyperdrive:DB`, `durable_objects.bindings:ROOM`, `ai:AI`,
// `previews.hyperdrive:DB`; an entry without a name counts as its kind (`triggers.crons`, `routes`).
// Plain values (vars, flags) are not products.
function bindingIds(config, prefix = '') {
  const ids = new Set()
  if (!prefix && typeof config.name === 'string') ids.add(`worker:${config.name}`)
  const nameOf = (o) => o.binding ?? o.name ?? o.queue ?? o.service
  const visit = (path, v) => {
    if (Array.isArray(v)) {
      for (const item of v) {
        const name = item && typeof item === 'object' ? nameOf(item) : undefined
        ids.add(typeof name === 'string' ? `${prefix}${path}:${name}` : `${prefix}${path}`)
      }
    } else if (v && typeof v === 'object') {
      if (typeof v.binding === 'string') ids.add(`${prefix}${path}:${v.binding}`)
      else
        for (const [k, sub] of Object.entries(v)) if (Array.isArray(sub)) visit(`${path}.${k}`, sub)
    }
  }
  for (const [key, value] of Object.entries(config)) {
    if (key === 'previews' && !prefix) {
      for (const id of bindingIds(value ?? {}, 'previews.')) ids.add(id)
      continue
    }
    visit(key, value)
  }
  return ids
}

const baseRef = process.argv[2] ?? 'origin/main'
const base = git('merge-base', baseRef, 'HEAD').trim()
const head = parseJsonc(readFileSync(CONFIG, 'utf8'))
let before
try {
  before = bindingIds(parseJsonc(git('show', `${base}:${CONFIG}`)))
} catch {
  before = new Set()
}

const errors = []
const configs = git('ls-files', '-co', '--exclude-standard')
  .split('\n')
  .filter((f) => /(^|\/)wrangler\.(jsonc?|toml)$/.test(f))
for (const f of configs)
  if (f !== CONFIG)
    errors.push(
      `${f}: a second Worker config needs an ADR and support in scripts/check-bindings.mjs`,
    )
if ('env' in head)
  errors.push(
    `${CONFIG}: named environments (\`env\`) aren't checked yet; extend this script first`,
  )

const added = [...bindingIds(head)].filter((id) => !before.has(id))
if (added.length) {
  const adrs = git('diff', '--name-only', '--diff-filter=A', base, '--', 'docs/adr')
    .split('\n')
    .filter((f) => /^docs\/adr\/\d{4}-.+\.md$/.test(f))
  const text = adrs.map((f) => readFileSync(f, 'utf8')).join('\n')
  for (const id of added) {
    const name = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id.split('.').at(-1)
    if (!new RegExp(`\\b${name.replace(/[^\w]/g, '\\$&')}\\b`).test(text))
      errors.push(
        `${id} is new: add docs/adr/NNNN-*.md naming its trigger and mentioning "${name}"`,
      )
  }
}
for (const key of STORAGE) {
  const previews = new Set((head.previews?.[key] ?? []).map((b) => b.binding))
  for (const b of head[key] ?? [])
    if (!previews.has(b.binding))
      errors.push(
        `${key}:${b.binding} has no "previews" override (previews must not bind production data)`,
      )
}

if (errors.length) {
  for (const e of errors) console.error(`[bindings] ${e}`)
  process.exit(1)
}
console.log(`[bindings] ok (${added.length} new since ${base.slice(0, 7)})`)
