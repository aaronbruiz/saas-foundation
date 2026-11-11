// `pnpm test:visual [--baseline | --compare] [playwright args]` (run it through
// `scripts/test-lock.sh visual`): starts the Playwright browser server from the Docker image pinned
// to the installed @playwright/test version, runs the visual tests against it
// (playwright.visual.config.ts), and stops it. ADR-0046, docs/testing.md. Modes:
// - no flag: the checks only (strict CSP in every browser, the WebKit <select> canary, the
//   keyboard pass); no screenshots, no baseline needed.
// - --baseline: the checks, and screenshots saved to the git-ignored apps/app/visual/.baseline/
//   (replaced), with the commit they were taken at in its COMMIT file.
// - --compare: the checks, and screenshots compared with that baseline; prints the baseline's
//   commit and what changed, and fails without a baseline (it never creates one).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'

const app = new URL('../apps/app/', import.meta.url).pathname
const baseline = `${app}visual/.baseline/`
const commitFile = `${baseline}COMMIT`
const results = `${app}test-results/visual-results.jsonl`
const args = process.argv.slice(2)
const mode = args.includes('--baseline')
  ? 'baseline'
  : args.includes('--compare')
    ? 'compare'
    : 'check'
const passThrough = args.filter((a) => a !== '--baseline' && a !== '--compare')
// The mode alone decides whether screenshots are written: `-u`/`--update-snapshots` would let a
// compare (or a check) write the baseline and report it unchanged.
if (passThrough.some((a) => a === '-u' || a.startsWith('--update-snapshots'))) {
  console.error('[visual] snapshot updates come only from --baseline; drop -u/--update-snapshots')
  process.exit(2)
}
if (args.includes('--baseline') && args.includes('--compare')) {
  console.error('[visual] --baseline or --compare, not both')
  process.exit(2)
}
if (mode === 'compare' && !existsSync(commitFile)) {
  console.error('[visual] no baseline: run `pnpm test:visual --baseline` first (before the change)')
  process.exit(1)
}
const git = (...a) => execFileSync('git', a, { cwd: app, encoding: 'utf8' }).trim()
const update = { check: 'none', baseline: 'all', compare: 'none' }[mode]
if (mode === 'baseline') rmSync(baseline, { recursive: true, force: true })
rmSync(results, { force: true })
const { version } = createRequire(`${app}package.json`)('@playwright/test/package.json')
const image = `mcr.microsoft.com/playwright:v${version}-noble`
const port = 3001
const name = `saas-visual-${process.pid}`

const listening = () =>
  new Promise((resolve) => {
    const s = connect(port, '127.0.0.1', () => (s.destroy(), resolve(true)))
    s.on('error', () => resolve(false))
  })
if (await listening()) {
  console.error(`[visual] port ${port} is in use; the browser server needs it.`)
  process.exit(1)
}

execFileSync(
  'docker',
  [
    'run',
    '--rm',
    '-d',
    '--init',
    '--network',
    'host',
    '--name',
    name,
    '--user',
    'pwuser',
    '-w',
    '/home/pwuser',
    image,
    '/bin/sh',
    '-c',
    `npx -y playwright@${version} run-server --port ${port} --host 127.0.0.1`,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)
const stop = () => spawnSync('docker', ['stop', name], { stdio: 'ignore' })

let code
try {
  const deadline = Date.now() + 180_000
  while (!(await listening())) {
    if (Date.now() > deadline) throw new Error(`[visual] browser server (${image}) didn't start`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log(`[visual] browsers from ${image}, mode ${mode}`)
  if (mode === 'compare')
    console.log(`[visual] baseline: ${readFileSync(commitFile, 'utf8').trim()}`)
  code = await new Promise((resolve) => {
    const run = spawn(
      'pnpm',
      [
        'exec',
        'playwright',
        'test',
        '-c',
        'playwright.visual.config.ts',
        `--update-snapshots=${update}`,
        ...passThrough,
      ],
      {
        cwd: app,
        stdio: 'inherit',
        env: {
          ...process.env,
          PW_WS: `ws://127.0.0.1:${port}/`,
          VISUAL_MODE: mode,
          VISUAL_RESULTS: results,
        },
      },
    )
    run.on('exit', (c) => resolve(c ?? 1))
  })
} finally {
  stop()
}

if (mode === 'baseline') {
  const shots = existsSync(baseline)
    ? readdirSync(baseline, { recursive: true }).filter((f) => String(f).endsWith('.png')).length
    : 0
  if (shots) {
    const dirty = git('status', '--porcelain') ? ' with uncommitted changes' : ''
    writeFileSync(commitFile, `${git('rev-parse', 'HEAD')}${dirty} (${new Date().toISOString()})\n`)
  }
  console.log(
    `[visual] baseline: ${shots} screenshots${shots ? `, ${readFileSync(commitFile, 'utf8').trim()}` : ''}`,
  )
}
if (mode === 'compare') {
  const rows = existsSync(results)
    ? readFileSync(results, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  const not = (o) => rows.filter((r) => r.outcome === o).map((r) => r.name)
  const [changed, missing] = [not('changed'), not('missing')]
  for (const n of changed) console.log(`[visual] changed: ${n}`)
  for (const n of missing) console.log(`[visual] not in the baseline: ${n}`)
  console.log(
    `[visual] baseline ${readFileSync(commitFile, 'utf8').trim().split(' ')[0].slice(0, 7)}, ${rows.length} compared, ${changed.length} changed${missing.length ? `, ${missing.length} not in the baseline` : ''}`,
  )
}
process.exit(code)
