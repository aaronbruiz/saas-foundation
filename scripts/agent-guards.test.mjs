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

test('the worker guard refuses input without a command', () => {
  const r = spawnSync('bash', [GUARD], {
    input: JSON.stringify({ tool_input: {} }),
    encoding: 'utf8',
  })
  assert.equal(r.status, 2)
})

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

// Not a real credential: a value no other output contains, so finding it anywhere is a leak.
const PASSWORD = 'test-lock-fixture-pw-7Qx2Lm9'
const SECRET_URL_LINE = `hyperdrives: { DB: 'postgres://user:${PASSWORD}@localhost:5432/app_test' },`
const git = (cwd, ...args) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).stdout.trim()
/** A clone with one commit, and a way to run the lock in it and read that run's log. */
const committedClone = () => {
  const repo = clone(SECRET_URL_LINE)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  const lock = (env) => {
    const r = spawnSync('bash', [LOCK, 'test'], { cwd: repo, env, encoding: 'utf8' })
    const path = join(repo, r.stdout.match(/full output in (.+)/)[1])
    return { ...r, log: existsSync(path) ? readFileSync(path, 'utf8') : null }
  }
  return { repo, head: git(repo, 'rev-parse', 'HEAD'), lock }
}

test("a run's log records the commit it ran on and the tests' exit status", () => {
  const { head, lock } = committedClone()
  const r = lock(stubPnpm('echo full-output\nexit 7'))
  assert.equal(r.status, 7)
  assert.match(r.log, new RegExp(`^test-lock: pnpm test at ${head}$`, 'm'))
  assert.match(
    r.log,
    new RegExp(`at the start the working tree matches ${head} \\(ignored files not compared\\)`),
  )
  assert.match(r.log, /after the run, HEAD and the compared files are as they were at the start/)
  assert.match(r.log, new RegExp(`^test-lock: tests exit 7 at ${head}$`, 'm'))
  assert.match(r.stdout, /test-lock: full output in .+\n$/)
  assert.match(r.log, /full-output/)
})

test("a run on uncommitted or untracked files says its result covers no commit, without the files' content", () => {
  const { repo, lock } = committedClone()
  writeFileSync(join(repo, 'new.test.ts'), 'x\n')
  writeFileSync(join(repo, 'apps/app/vitest.config.ts'), `${SECRET_URL_LINE}\n// edited\n`)
  const env = stubPnpm('exit 0')
  const r = lock(env)
  assert.equal(r.status, 0)
  assert.match(
    r.log,
    /differs from [0-9a-f]{40} \(ignored files not compared\), so this result covers no commit/,
  )
  assert.match(r.log, /^ M apps\/app\/vitest\.config\.ts$/m)
  assert.match(r.log, /^\?\? new\.test\.ts$/m)
  const locks = readdirSync(join(env.HOME, '.cache/saas-foundation/locks')).join('\n')
  const logs = readdirSync(join(repo, '.git/test-logs')).join('\n')
  for (const text of [r.stdout, r.stderr, r.log, locks, logs])
    assert.equal(text.includes(PASSWORD), false)
})

test('a file that changes during the run is reported: the result covers no single state', () => {
  const { head, lock } = committedClone()
  const r = lock(stubPnpm('echo "// changed" >> apps/app/vitest.config.ts'))
  assert.equal(r.status, 0)
  assert.match(r.log, new RegExp(`at the start the working tree matches ${head}`))
  assert.match(r.log, /changed during the run, so this result covers no single state/)
  assert.doesNotMatch(r.log, /as they were at the start/)
})

test('a run that waited for the lock records the commit it ran on, not the one it was started on', async () => {
  const { repo, head } = committedClone()
  const env = stubPnpm('sleep 0.6')
  const run = () =>
    new Promise((resolve) => {
      let out = ''
      const child = spawn('bash', [LOCK, 'test'], { cwd: repo, env })
      child.stdout.on('data', (d) => (out += d))
      child.on('close', () => resolve(out))
    })
  const first = run()
  await new Promise((r) => setTimeout(r, 200))
  const second = run()
  await new Promise((r) => setTimeout(r, 200))
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'later')
  const later = git(repo, 'rev-parse', 'HEAD')
  assert.notEqual(later, head)
  assert.match(await first, new RegExp(`pnpm test at ${head}`))
  assert.match(await first, /changed during the run/)
  assert.match(await second, new RegExp(`pnpm test at ${later}`))
})

test("a log that can't be written is reported apart from the tests' exit status", () => {
  const { repo, lock } = committedClone()
  mkdirSync(join(repo, '.git/test-logs'))
  chmodSync(join(repo, '.git/test-logs'), 0o555)
  const failing = lock(stubPnpm('echo full-output\nexit 7'))
  assert.equal(failing.status, 7)
  assert.equal(failing.log, null)
  assert.match(failing.stdout, /full-output/)
  assert.match(failing.stdout, /^test-lock: tests exit 7 at [0-9a-f]{40}\n$/m)
  assert.match(failing.stderr, /couldn't be written or is incomplete; that isn't a test result/)
  const passing = lock(stubPnpm('exit 0'))
  assert.equal(passing.status, 0)
  assert.match(passing.stderr, /couldn't be written or is incomplete/)
  chmodSync(join(repo, '.git/test-logs'), 0o755)
})

test('a log that stops being writable during the run is reported, even when only its last lines fail', () => {
  const { lock } = committedClone()
  const r = lock(stubPnpm('echo full-output\nsleep 0.3\nchmod 444 .git/test-logs/*.log\nexit 7'))
  assert.equal(r.status, 7)
  assert.match(r.log, /full-output/)
  assert.doesNotMatch(r.log, /tests exit/)
  assert.match(r.stdout, /^test-lock: tests exit 7 at [0-9a-f]{40}\n$/m)
  assert.doesNotMatch(r.stdout, /tests exit 7[^]*full output in/)
  assert.match(r.stderr, /couldn't be written or is incomplete; that isn't a test result/)
})

test("closing the lock's output doesn't end the tests or change their exit status", () => {
  const { repo } = committedClone()
  const done = join(repo, '.git/done')
  const env = stubPnpm(
    `for i in 1 2 3 4 5; do echo line-$i; sleep 0.1; done\necho done > "${done}"\nexit 7`,
  )
  const r = spawnSync(
    'bash',
    ['-c', 'bash "$0" test | head -n 1; echo "lock exit ${PIPESTATUS[0]}"', LOCK],
    {
      cwd: repo,
      env,
      encoding: 'utf8',
    },
  )
  assert.match(r.stdout, /lock exit 7/)
  assert.equal(existsSync(done), true)
  const [name] = readdirSync(join(repo, '.git/test-logs'))
  const log = readFileSync(join(repo, '.git/test-logs', name), 'utf8')
  assert.match(log, /line-5/)
  assert.match(log, /^test-lock: tests exit 7 at [0-9a-f]{40}$/m)
})

test('a Git setting naming a diff, fsmonitor or untracked-files option changes nothing the lock runs or records', () => {
  const { repo, lock } = committedClone()
  const ran = join(repo, '.git/helper-ran')
  git(repo, 'config', 'diff.external', `touch "${ran}"; true`)
  git(repo, 'config', 'core.fsmonitor', `touch "${ran}"; false`)
  git(repo, 'config', 'status.showUntrackedFiles', 'no')
  writeFileSync(join(repo, 'new.test.ts'), 'x\n')
  writeFileSync(join(repo, 'apps/app/vitest.config.ts'), `${SECRET_URL_LINE}\n// edited\n`)
  const r = lock(stubPnpm('exit 0'))
  assert.equal(r.status, 0)
  assert.equal(existsSync(ran), false)
  assert.match(r.log, /^\?\? new\.test\.ts$/m)
  assert.match(r.log, /covers no commit/)
})

test('in a repository with no commit the run happens, records "no commit" and still sees a staged file change', () => {
  const repo = clone(SECRET_URL_LINE)
  git(repo, 'add', '-A')
  const r = spawnSync('bash', [LOCK, 'test'], {
    cwd: repo,
    env: stubPnpm('echo "// changed" >> apps/app/vitest.config.ts'),
    encoding: 'utf8',
  })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^test-lock: pnpm test at no commit$/m)
  assert.match(r.stdout, /covers no commit/)
  assert.match(r.stdout, /changed during the run/)
  const again = spawnSync('bash', [LOCK, 'test'], {
    cwd: repo,
    env: stubPnpm('echo "// changed again" >> apps/app/vitest.config.ts'),
    encoding: 'utf8',
  })
  assert.match(again.stdout, /changed during the run/)
})

test('each accepted command runs its pnpm script with the given arguments, and nothing else', () => {
  for (const [kind, script] of [
    ['test', 'test'],
    ['e2e', 'test:e2e'],
    ['visual', 'test:visual'],
  ]) {
    const r = spawnSync('bash', [LOCK, kind, '--one', 'two words'], {
      cwd: clone(),
      env: stubPnpm('for a in "$@"; do echo "arg[$a]"; done'),
      encoding: 'utf8',
    })
    assert.equal(r.status, 0)
    assert.match(
      r.stdout,
      new RegExp(`arg\\[${script}\\]\\narg\\[--one\\]\\narg\\[two words\\]\\n`),
    )
  }
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
