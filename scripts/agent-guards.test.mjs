// Runs the worker's push guard and the test lock with stubs, so nothing is pushed or tested for real.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const GUARD = fileURLToPath(new URL('../.claude/hooks/worker-guard.sh', import.meta.url))
const LOCK = fileURLToPath(new URL('./test-lock.sh', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'agent-guards-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const guard = (command) =>
  spawnSync('bash', [GUARD], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  }).status

for (const command of [
  'git push origin feat/x',
  'git -C . push origin feat/x',
  'git -c push.default=current push',
  'cd apps && git push',
  'gh pr create --fill',
  'gh pr merge 1 --squash',
]) {
  test(`a worker can't run: ${command}`, () => assert.equal(guard(command), 2))
}

for (const command of [
  'git commit -m "docs: push notes"',
  'git status',
  'pnpm test',
  'gh pr view 1',
  'cat scripts/git-push-notes.md',
]) {
  test(`a worker can run: ${command}`, () => assert.equal(guard(command), 0))
}

test('the test lock refuses anything but test and e2e', () => {
  for (const args of [[], ['deploy'], ['run', 'deploy']]) {
    assert.equal(spawnSync('bash', [LOCK, ...args], { encoding: 'utf8' }).status, 2)
  }
})

test('two test runs through the lock never overlap', async () => {
  const log = join(dir, 'runs.log')
  const pnpm = join(dir, 'pnpm')
  writeFileSync(pnpm, `#!/bin/sh\necho start >> "${log}"\nsleep 0.3\necho end >> "${log}"\n`)
  chmodSync(pnpm, 0o755)
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` }
  const run = () =>
    new Promise((resolve) => spawn('bash', [LOCK, 'test'], { env }).on('close', resolve))
  assert.deepEqual(await Promise.all([run(), run()]), [0, 0])
  assert.equal(readFileSync(log, 'utf8'), 'start\nend\nstart\nend\n')
})
