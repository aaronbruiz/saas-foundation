import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { classifyChanges } from './classify-changes.mjs'

for (const [name, files, expected] of [
  ['documentation avoids app checks', ['docs/adr/0040.md', 'AGENTS.md'], 'light'],
  [
    'static sites retain their own checks',
    ['apps/site/src/index.astro', 'apps/docs/package.json'],
    'light',
  ],
  ['mixed changes need app checks', ['README.md', 'apps/app/src/index.ts'], 'full'],
  ['unknown Markdown needs app checks', ['packages/db/README.md'], 'full'],
  ['an empty diff needs app checks', [], 'full'],
]) {
  test(name, () => assert.equal(classifyChanges(files), expected))
}

const script = new URL('./classify-changes.mjs', import.meta.url).pathname

test('the CLI keeps full checks when the diff cannot be read', () => {
  assert.equal(
    execFileSync(process.execPath, [script, 'nonexistent-ref'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim(),
    'full',
  )
})

test('git diffs include both rename paths, deletions, and empty diffs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-changes-'))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  const classify = (base = 'HEAD^') =>
    execFileSync(process.execPath, [script, base], { cwd, encoding: 'utf8' }).trim()
  const commit = () => {
    git('add', '-A')
    git('commit', '-qm', 'fixture')
  }
  try {
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    mkdirSync(join(cwd, 'docs'))
    writeFileSync(join(cwd, 'code.ts'), 'example')
    commit()
    renameSync(join(cwd, 'code.ts'), join(cwd, 'docs/example.md'))
    commit()
    assert.equal(classify(), 'full')
    renameSync(join(cwd, 'docs/example.md'), join(cwd, 'code.ts'))
    commit()
    assert.equal(classify(), 'full')
    renameSync(join(cwd, 'code.ts'), join(cwd, 'docs/example.md'))
    commit()
    renameSync(join(cwd, 'docs/example.md'), join(cwd, 'docs/new.md'))
    commit()
    assert.equal(classify(), 'light')
    rmSync(join(cwd, 'docs/new.md'))
    commit()
    assert.equal(classify(), 'light')
    assert.equal(classify('HEAD'), 'full')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CI keeps one job and gates every expensive step', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.equal((workflow.split('\njobs:\n')[1].match(/^ {2}[\w-]+:/gm) ?? []).length, 1)
  assert.ok(!workflow.includes('    services:'))
  const steps = workflow.split(/^ {6}- /m).slice(1)
  const always = [
    'uses: actions/checkout@',
    'name: Bindings need an ADR',
    'run: node scripts/check-secrets.mjs',
    'id: scope',
    'uses: ./.github/actions/setup',
    'run: pnpm install --frozen-lockfile',
  ]
  for (const step of steps) {
    if (always.some((prefix) => step.startsWith(prefix))) continue
    assert.ok(step.includes('if: steps.scope.outputs.scope'), step.split('\n')[0])
  }
  const scope = steps.find((step) => step.startsWith('id: scope'))
  assert.ok(scope.includes('scope=full'))
  assert.ok(scope.includes('if [ "$EVENT_NAME" = pull_request ]; then'))
})
