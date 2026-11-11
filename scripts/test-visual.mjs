// `pnpm test:visual` (run it through `scripts/test-lock.sh visual`): starts the Playwright browser
// server from the Docker image pinned to the installed @playwright/test version, runs the visual
// tests against it (playwright.visual.config.ts), and stops it. Arguments go to `playwright test`
// (e.g. `--update-snapshots` after an intended change, reviewed in the PR). ADR-0046.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect } from 'node:net'

const app = new URL('../apps/app/', import.meta.url).pathname
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
  console.log(`[visual] browsers from ${image}`)
  code = await new Promise((resolve) => {
    const run = spawn(
      'pnpm',
      ['exec', 'playwright', 'test', '-c', 'playwright.visual.config.ts', ...process.argv.slice(2)],
      { cwd: app, stdio: 'inherit', env: { ...process.env, PW_WS: `ws://127.0.0.1:${port}/` } },
    )
    run.on('exit', (c) => resolve(c ?? 1))
  })
} finally {
  stop()
}
process.exit(code)
