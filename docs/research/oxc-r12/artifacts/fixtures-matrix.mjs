// R12: every boundary fixture from scripts/lint-boundaries.test.mjs under four setups.
// Run from the spike clone root: node <path>/fixtures-matrix.mjs > fixtures-matrix.md
// Setups: ESLint with the original config (eslint.orig.config.js), ESLint naive hybrid
// (eslint-plugin-oxlint off-list from the full migrated .oxlintrc.full.json), ESLint safe hybrid
// (off-list from .oxlintrc.json without no-restricted-imports / no-require-imports), and
// native Oxlint 1.89.0 alone with the full migrated config (fixture written to its path).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const cwd = process.cwd()
const { ESLint } = createRequire(resolve(cwd, 'package.json'))('eslint')
const src = readFileSync('scripts/lint-boundaries.test.mjs', 'utf8')
const body = src
  .slice(src.indexOf('const root'), src.indexOf('for (const [file'))
  .replace(/const eslint = .*\n/, '')
  .replace(/const BOUNDARY_RULES[\s\S]*?\]\)\n/, '')
  .replace("new URL('..', import.meta.url).pathname", JSON.stringify(cwd + '/'))
const cases = new Function(body + '; return cases')()
const BOUNDARY = /restricted|require-imports/

const setups = {
  original: new ESLint({ cwd, overrideConfigFile: 'eslint.orig.config.js' }),
  naive: new ESLint({ cwd, overrideConfigFile: 'eslint.naive.config.js' }),
  safe: new ESLint({ cwd, overrideConfigFile: 'eslint.config.js' }),
}
const verdict = (expected, msgs) =>
  expected === null
    ? msgs.length === 0
      ? 'pass'
      : 'FAIL'
    : msgs.some((m) => m.includes(expected))
      ? 'pass'
      : 'FAIL'

const rows = []
const totals = {}
for (const [i, [file, code, expected]] of cases.entries()) {
  const row = { i: i + 1, file, code, expected }
  for (const [name, eslint] of Object.entries(setups)) {
    const [r] = await eslint.lintText(code, { filePath: file })
    row[name] = verdict(
      expected,
      r.messages.filter((m) => BOUNDARY.test(m.ruleId ?? '')).map((m) => m.message),
    )
    if (name === 'original')
      row.rule =
        [
          ...new Set(r.messages.filter((m) => BOUNDARY.test(m.ruleId ?? '')).map((m) => m.ruleId)),
        ].join(', ') || '-'
  }
  const orig = existsSync(file) ? readFileSync(file, 'utf8') : null
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, code + '\n')
  let out
  try {
    out = execFileSync(
      'node_modules/.bin/oxlint',
      ['-c', '.oxlintrc.full.json', '--format', 'json', file],
      { encoding: 'utf8' },
    )
  } catch (e) {
    out = e.stdout
  }
  if (orig === null) rmSync(file)
  else writeFileSync(file, orig)
  const ox = JSON.parse(out)
    .diagnostics.filter((d) => BOUNDARY.test(d.code))
    .map((d) => `${d.message} ${d.help ?? ''}`)
  row.oxlint = verdict(expected, ox)
  if (row.oxlint === 'FAIL' && expected === 'require()' && ox.length)
    row.oxlint = 'fires (other message)'
  for (const k of ['original', 'naive', 'safe', 'oxlint'])
    totals[`${k}:${row[k]}`] = (totals[`${k}:${row[k]}`] ?? 0) + 1
  rows.push(row)
}
const esc = (s) => String(s).replaceAll('|', '\\|').replaceAll('`', "'")
console.log(
  '| # | file | code | expected message fragment | ESLint rule | original | naive hybrid | safe hybrid | Oxlint native |',
)
console.log('|---|---|---|---|---|---|---|---|---|')
for (const r of rows)
  console.log(
    `| ${r.i} | ${esc(r.file.replace(cwd + '/', ''))} | \`${esc(r.code)}\` | ${r.expected === null ? '(allowed)' : esc(r.expected)} | ${r.rule} | ${r.original} | ${r.naive} | ${r.safe} | ${r.oxlint} |`,
  )
console.log('\nTotals: ' + JSON.stringify(totals))
