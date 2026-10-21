import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyChanges } from './classify-changes.mjs'

for (const [name, files, count, expected] of [
  [
    'documentation avoids app checks',
    [{ filename: 'docs/adr/0040.md' }, { filename: 'AGENTS.md' }],
    2,
    'light',
  ],
  [
    'static sites retain their own checks',
    [{ filename: 'apps/site/src/index.astro' }, { filename: 'apps/docs/package.json' }],
    2,
    'light',
  ],
  [
    'mixed changes need app checks',
    [{ filename: 'README.md' }, { filename: 'apps/app/src/index.ts' }],
    2,
    'full',
  ],
  ['unknown Markdown needs app checks', [{ filename: 'packages/db/README.md' }], 1, 'full'],
  [
    'renaming app code into docs needs app checks',
    [{ filename: 'docs/example.md', previous_filename: 'apps/app/src/example.ts' }],
    1,
    'full',
  ],
  [
    'renaming docs into app code needs app checks',
    [{ filename: 'apps/app/src/example.ts', previous_filename: 'docs/example.md' }],
    1,
    'full',
  ],
  [
    'renaming within docs avoids app checks',
    [{ filename: 'docs/new.md', previous_filename: 'docs/old.md' }],
    1,
    'light',
  ],
  ['an empty diff needs app checks', [], 0, 'full'],
  ['an incomplete list needs app checks', [{ filename: 'README.md' }], 2, 'full'],
  ['a malformed list needs app checks', [{ previous_filename: 'README.md' }], 1, 'full'],
  ['missing count needs app checks', [{ filename: 'README.md' }], undefined, 'full'],
]) {
  test(name, () => assert.equal(classifyChanges(files, count), expected))
}

// Exercise the CLI's actual git diff, including deletes and rename endpoints.
const { execFileSync, spawnSync } = await import('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const script = new URL('./classify-changes.mjs', import.meta.url).pathname

test('the CLI keeps full checks when the diff cannot be read', () => {
  const result = execFileSync(process.execPath, [script, 'nonexistent-ref'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  assert.equal(result.trim(), 'full')
})

test('the CLI retains full checks for malformed API data', () => {
  assert.equal(
    execFileSync(process.execPath, [script, '--pr-files', '1'], {
      input: '{',
      encoding: 'utf8',
    }).trim(),
    'full',
  )
})

test('git diffs include deleted code even when it is renamed to documentation', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-changes-'))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  const classify = () =>
    execFileSync(process.execPath, [script, 'HEAD^'], { cwd, encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    mkdirSync(join(cwd, 'docs'))
    writeFileSync(join(cwd, 'code.ts'), 'example')
    git('add', '.')
    git('commit', '-qm', 'base')
    renameSync(join(cwd, 'code.ts'), join(cwd, 'docs/example.md'))
    git('add', '-A')
    git('commit', '-qm', 'move')
    assert.equal(classify(), 'full')
    rmSync(join(cwd, 'docs/example.md'))
    git('add', '-A')
    git('commit', '-qm', 'delete docs')
    assert.equal(classify(), 'light')
    assert.equal(
      execFileSync(process.execPath, [script, 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
      'full',
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('ci-ok passes only when the selected check succeeds and the other skips', async () => {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const gate = workflow.split('      - name: Selected checks passed\n        run: |\n')[1]
  assert.ok(gate, 'the final gate script exists')
  for (const scope of ['light', 'full', '', 'unexpected']) {
    for (const changes of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const format of ['success', 'failure', 'cancelled', 'skipped']) {
        for (const check of ['success', 'failure', 'cancelled', 'skipped']) {
          const expected =
            changes === 'success' &&
            ((scope === 'light' && format === 'success' && check === 'skipped') ||
              (scope === 'full' && check === 'success' && format === 'skipped'))
          const result = spawnSync('bash', ['-e', '-c', gate], {
            env: { ...process.env, CHANGES: changes, SCOPE: scope, FORMAT: format, CHECK: check },
          })
          assert.equal(
            result.status === 0,
            expected,
            JSON.stringify({ scope, changes, format, check }),
          )
        }
      }
    }
  }
})

test('lightweight PRs still validate binding restrictions before classification', async () => {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const changes = workflow.split('  changes:\n')[1].split('\n  format:')[0]
  assert.ok(changes.includes('run: node scripts/check-bindings.mjs HEAD^1'))
})
