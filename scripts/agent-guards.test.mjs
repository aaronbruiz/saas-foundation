// Runs the worker's push guard and the test lock with stubs, so nothing is pushed or tested for real.
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

const URL_LINE = "hyperdrives: { DB: 'postgres://user:secret@localhost:5432/app_test' },"
const clone = (config = URL_LINE) => {
  const repo = mkdtempSync(join(dir, 'clone-'))
  spawnSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, 'apps/app'), { recursive: true })
  writeFileSync(join(repo, 'apps/app/vitest.config.ts'), `${config}\n`)
  return repo
}
const stubPnpm = (body) => {
  const bin = mkdtempSync(join(dir, 'bin-'))
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, 'pnpm'), 0o755)
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: mkdtempSync(join(dir, 'home-')),
  }
}

test('the test lock keeps the exit code of a failing run and its full output', () => {
  const r = spawnSync('bash', [LOCK, 'test'], {
    cwd: clone(),
    env: stubPnpm('echo full-output\nexit 7'),
    encoding: 'utf8',
  })
  assert.equal(r.status, 7)
  const log = r.stdout.match(/full output in (.+)/)[1]
  assert.match(r.stdout, /full-output/)
  assert.match(log, /test-logs/)
})

test('the lock is named from the test database and leaves out its credentials', () => {
  const env = stubPnpm('exit 0')
  assert.equal(spawnSync('bash', [LOCK, 'test'], { cwd: clone(), env }).status, 0)
  assert.deepEqual(readdirSync(join(env.HOME, '.cache/saas-foundation/locks')), [
    'localhost-5432-app_test.lock',
  ])
})

test('without a test database URL the lock refuses to run', () => {
  const log = join(dir, 'no-url.log')
  const env = stubPnpm(`echo ran >> "${log}"`)
  const r = spawnSync('bash', [LOCK, 'test'], { cwd: clone('// no url'), env, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no test database URL/)
  assert.equal(existsSync(log), false)
})

test('test runs from two clones of the same database never overlap', async () => {
  const log = join(dir, 'runs.log')
  const env = stubPnpm(`echo start >> "${log}"\nsleep 0.3\necho end >> "${log}"`)
  const run = (cwd) =>
    new Promise((resolve) =>
      spawn('bash', [LOCK, 'test'], { cwd, env, stdio: 'ignore' }).on('close', resolve),
    )
  assert.deepEqual(await Promise.all([run(clone()), run(clone())]), [0, 0])
  assert.equal(readFileSync(log, 'utf8'), 'start\nend\nstart\nend\n')
})
