// Proves scripts/check-migrations.mjs's history check (invariant 10) refuses each kind of change to
// an applied migration and accepts a new one, including in the shallow checkouts ci.yml makes (a
// depth-2 PR merge commit diffed against HEAD^1, a push diffed against the event's `before`).
// Each test copies the real packages/db/drizzle into a throwaway git repository. Run by `pnpm lint`.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const repoRoot = new URL('..', import.meta.url).pathname
const script = join(repoRoot, 'scripts/check-migrations.mjs')
const DIR = 'packages/db/drizzle'
const JOURNAL = `${DIR}/meta/_journal.json`
const temps = []
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })))

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'check-migrations-'))
  temps.push(d)
  return d
}
const git = (cwd, ...a) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a],
    {
      cwd,
      encoding: 'utf8',
    },
  )
const commitAll = (cwd, msg) => {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', msg)
  return git(cwd, 'rev-parse', 'HEAD').trim()
}

// A repository whose first commit holds the real migrations; returns it and that commit.
function repo() {
  const cwd = tmp()
  git(cwd, 'init', '-q', '-b', 'main')
  cpSync(join(repoRoot, DIR), join(cwd, DIR), { recursive: true })
  return { cwd, base: commitAll(cwd, 'base') }
}
// Staged first, as in CI's committed checkout (an untracked rename target would read as a delete).
const check = (cwd, base) => {
  git(cwd, 'add', '-A')
  return spawnSync('node', [script, base, '--history-only'], { cwd, encoding: 'utf8' })
}
const passes = (r) => assert.equal(r.status, 0, r.stderr)
const fails = (r, fragment) => {
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stderr, fragment)
}

const journal = (cwd) => JSON.parse(readFileSync(join(cwd, JOURNAL), 'utf8'))
const writeJournal = (cwd, j) => writeFileSync(join(cwd, JOURNAL), JSON.stringify(j, null, 2))
const lastEntry = (cwd) => journal(cwd).entries.at(-1)

// Adds migration 0099 the way drizzle-kit does: SQL, snapshot, and a journal entry at `when`.
function addMigration(cwd, when = lastEntry(cwd).when + 1000) {
  const tag = '0099_new_migration'
  writeFileSync(join(cwd, DIR, `${tag}.sql`), 'ALTER TABLE "project" ADD COLUMN "note" text;')
  writeFileSync(join(cwd, DIR, 'meta/0099_snapshot.json'), '{}')
  const j = journal(cwd)
  j.entries.push({ idx: j.entries.length, version: '7', when, tag, breakpoints: true })
  writeJournal(cwd, j)
}

test('a new migration appended after the applied ones passes', () => {
  const { cwd, base } = repo()
  addMigration(cwd)
  passes(check(cwd, base))
})

test('no migration change passes', () => {
  const { cwd, base } = repo()
  writeFileSync(join(cwd, 'README.md'), 'unrelated')
  passes(check(cwd, base))
})

test('an edited applied migration is refused', () => {
  const { cwd, base } = repo()
  const sql = join(cwd, DIR, '0004_giant_silver_surfer.sql')
  writeFileSync(sql, `${readFileSync(sql, 'utf8')}\nCREATE INDEX "x" ON "project" ("name");`)
  fails(check(cwd, base), /0004_giant_silver_surfer\.sql exists on .* was modified/)
})

test('a renamed applied migration is refused', () => {
  const { cwd, base } = repo()
  renameSync(join(cwd, DIR, '0003_amazing_thunderbolt.sql'), join(cwd, DIR, '0003_renamed.sql'))
  fails(check(cwd, base), /0003_amazing_thunderbolt\.sql exists on .* was renamed to/)
})

test('a deleted applied snapshot is refused', () => {
  const { cwd, base } = repo()
  rmSync(join(cwd, DIR, 'meta/0002_snapshot.json'))
  fails(check(cwd, base), /0002_snapshot\.json exists on .* was deleted/)
})

test('an edited applied journal entry is refused', () => {
  const { cwd, base } = repo()
  const j = journal(cwd)
  j.entries[1].tag = '0001_other'
  writeJournal(cwd, j)
  fails(check(cwd, base), /entry 1 \(0001_volatile_iron_lad\) changed or was removed/)
})

test('a removed journal entry is refused', () => {
  const { cwd, base } = repo()
  const j = journal(cwd)
  j.entries.pop()
  writeJournal(cwd, j)
  fails(check(cwd, base), /changed or was removed/)
})

test('a new migration dated before the last applied one is refused', () => {
  const { cwd, base } = repo()
  addMigration(cwd, lastEntry(cwd).when)
  fails(check(cwd, base), /entry 6 \(0099_new_migration\) has `when` .* the migrator would skip it/)
})

test('a base commit missing from the checkout fails instead of passing', () => {
  const { cwd } = repo()
  fails(check(cwd, 'f'.repeat(40)), /is not a commit in this checkout/)
})

test('an all-zero base (a new branch) skips the history check', () => {
  const { cwd } = repo()
  const r = check(cwd, '0'.repeat(40))
  passes(r)
  assert.match(r.stdout, /history not checked/)
})

// GitHub's pull_request checkout: a merge commit of the PR into its base, fetched at depth 2.
function prMergeCheckout(change) {
  const { cwd } = repo()
  git(cwd, 'checkout', '-qb', 'pr')
  change(cwd)
  commitAll(cwd, 'pr change')
  git(cwd, 'checkout', '-q', 'main')
  writeFileSync(join(cwd, 'other.txt'), 'main moved on')
  commitAll(cwd, 'main moves')
  git(cwd, 'merge', '-q', '--no-ff', '-m', 'merge pr', 'pr')
  const clone = tmp()
  git(clone, 'clone', '-q', '--depth', '2', `file://${cwd}`, '.')
  return clone
}

test('a PR merge checkout at depth 2 accepts a new migration against HEAD^1', () => {
  passes(
    check(
      prMergeCheckout((cwd) => addMigration(cwd)),
      'HEAD^1',
    ),
  )
})

test('a PR merge checkout at depth 2 refuses an edited applied migration against HEAD^1', () => {
  const clone = prMergeCheckout((cwd) =>
    writeFileSync(join(cwd, DIR, '0000_overconfident_roughhouse.sql'), 'edited'),
  )
  fails(
    check(clone, 'HEAD^1'),
    /0000_overconfident_roughhouse\.sql exists on HEAD\^1 and was modified/,
  )
})

test("a push to main at depth 2 is checked against the event's before commit", () => {
  const { cwd } = repo()
  writeFileSync(join(cwd, 'other.txt'), 'previous squash')
  const before = commitAll(cwd, 'previous squash')
  addMigration(cwd)
  commitAll(cwd, 'squash with a migration')
  const clone = tmp()
  git(clone, 'clone', '-q', '--depth', '2', `file://${cwd}`, '.')
  passes(check(clone, before))
  rmSync(join(clone, DIR, '0000_overconfident_roughhouse.sql'))
  fails(check(clone, before), /0000_overconfident_roughhouse\.sql exists on .* was deleted/)
})

test('a new migration whose `when` is a string is refused', () => {
  const { cwd, base } = repo()
  addMigration(cwd)
  const j = journal(cwd)
  j.entries.at(-1).when = String(j.entries.at(-1).when)
  writeJournal(cwd, j)
  fails(check(cwd, base), /0099_new_migration\) has `when` ".*", not an integer/)
})

test('a new journal entry whose tag points outside the migrations folder is refused', () => {
  const { cwd, base } = repo()
  addMigration(cwd)
  writeFileSync(join(cwd, 'packages/db/outside.sql'), 'SELECT 1;')
  const j = journal(cwd)
  j.entries.at(-1).tag = '../outside'
  writeJournal(cwd, j)
  fails(check(cwd, base), /entry 6 has tag "\.\.\/outside", not a plain file name/)
})

test('a new migration whose SQL is a symlink is refused', () => {
  const { cwd, base } = repo()
  addMigration(cwd)
  rmSync(join(cwd, DIR, '0099_new_migration.sql'))
  writeFileSync(join(cwd, 'packages/db/outside.sql'), 'SELECT 1;')
  symlinkSync('../outside.sql', join(cwd, DIR, '0099_new_migration.sql'))
  fails(check(cwd, base), /0099_new_migration\.sql is missing or not a regular file/)
})

test('an applied migration replaced by a symlink is refused', () => {
  const { cwd, base } = repo()
  const sql = join(cwd, DIR, '0001_volatile_iron_lad.sql')
  writeFileSync(join(cwd, 'packages/db/outside.sql'), readFileSync(sql))
  rmSync(sql)
  symlinkSync('../outside.sql', sql)
  fails(check(cwd, base), /0001_volatile_iron_lad\.sql exists on .* changed type/)
})
