// Runs merge-readiness.mjs against a fake `gh` on PATH that answers `gh api <path>` (and the
// description-edits GraphQL query) from a fixture map, so the report is tested without GitHub.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { GOVERNANCE } from './merge-readiness.mjs'

const SCRIPT = new URL('./merge-readiness.mjs', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'merge-readiness-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// Prints FAKE_GH[path] (a string as is, anything else as JSON); `gh api graphql` answers
// FAKE_GH.graphql. An unknown path fails like a 404.
writeFileSync(
  join(dir, 'gh'),
  `#!/usr/bin/env node
const [cmd, path] = process.argv.slice(2)
const answers = JSON.parse(process.env.FAKE_GH)
if (cmd !== 'api' || !(path in answers)) { console.error('gh: HTTP 404: ' + path); process.exit(1) }
const a = answers[path]
process.stdout.write(typeof a === 'string' ? a : JSON.stringify(a))
`,
)
chmodSync(join(dir, 'gh'), 0o755)

const R = 'repos/{owner}/{repo}'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const NEWER = 'c'.repeat(40)
/** A job log whose actions/checkout step tested the merge of parents[0] into parents[1]. */
const checkoutLog = (parents) =>
  '2026-10-30T10:00:00Z ##[group]Run actions/checkout@3d3c42e5\n' +
  `2026-10-30T10:00:01Z HEAD is now at e9e3dca Merge ${parents[0]} into ${parents[1]}\n` +
  '2026-10-30T10:00:02Z ##[group]Run pnpm check\n'
const CI_RUNS = `${R}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&event=pull_request&per_page=100&page=1`

/** GitHub's answers for open PR #5 (head HEAD on branch feat/x) into main at `main`. */
function github({
  main = BASE,
  conclusion = 'success',
  parents = [HEAD, BASE],
  log,
  files,
  edits,
} = {}) {
  const answers = {
    [`${R}/pulls/5`]: {
      state: 'open',
      merged_at: null,
      number: 5,
      base: { ref: 'main' },
      head: { sha: HEAD, ref: 'feat/x', repo: { full_name: 'o/r' } },
    },
    [`${R}/git/ref/heads/main`]: { object: { sha: main } },
    [`${R}/compare/${main}...${HEAD}`]: { merge_base_commit: { sha: BASE } },
    [CI_RUNS]: {
      workflow_runs: [
        {
          id: 41,
          path: '.github/workflows/ci.yml',
          head_branch: 'feat/x',
          head_repository: { full_name: 'o/r' },
          pull_requests: [{ number: 5 }],
          created_at: '2026-10-30T10:00:00Z',
          status: 'completed',
          conclusion,
        },
      ],
    },
    [`${R}/actions/runs/41/jobs`]: {
      jobs: [
        { id: 1, name: 'changes', conclusion: 'success' },
        { id: 2, name: 'check + test', conclusion: 'success' },
      ],
    },
    [`${R}/actions/jobs/1/logs`]: 'no checkout here\n',
    [`${R}/actions/jobs/2/logs`]: log ?? checkoutLog(parents),
    [`${R}/pulls/5/files?per_page=100&page=1`]: files ?? [
      { filename: 'apps/app/src/x.ts', status: 'modified' },
    ],
    graphql: {
      data: {
        repository: { pullRequest: { userContentEdits: edits ?? { totalCount: 0, nodes: [] } } },
      },
    },
  }
  if (main !== BASE)
    answers[`${R}/compare/${BASE}...${main}`] = {
      ahead_by: 1,
      commits: [{ sha: NEWER, commit: { message: 'feat: something (#4)\n\nbody' } }],
      files: [{ filename: 'packages/db/src/x.ts' }],
    }
  return answers
}

const REVIEW = join(dir, 'review.md')
writeFileSync(REVIEW, 'Base `bbbbbbb` → head `aaaaaaa`, 3 files.\n\n**No findings.**\n')

function run(answers, args = ['5', '--review', REVIEW, '--approved-at', '2026-10-30T09:00:00Z']) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH: JSON.stringify(answers) },
  })
  return { status: r.status, output: r.stdout + r.stderr }
}

function notCovered(r, pattern) {
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, pattern)
  assert.match(r.output, /NOT COVERED/)
}

test('fresh review and green CI on the current head and main print the evidence line and pass', () => {
  const r = run(github())
  assert.equal(r.status, 0, r.output)
  assert.match(
    r.output,
    /^head aaaaaaa; base bbbbbbb; review .*review\.md at aaaaaaa\/bbbbbbb; CI 41 tested e9e3dca \(parents aaaaaaa, bbbbbbb\), success; main bbbbbbb; governance: none; description edits after approval: 0$/m,
  )
  assert.match(r.output, /Evidence covers the current head and main/)
})

test("every run says it checks freshness only, not the owner's approval", () => {
  for (const answers of [github(), github({ conclusion: 'failure' })])
    assert.match(
      run(answers).output,
      /freshness only; it doesn't establish the owner's approval or authorize a merge/,
    )
})

test('a review of an earlier head is stale and fails', () => {
  writeFileSync(join(dir, 'old.md'), 'Base `bbbbbbb` → head `1234567`, 1 file.\n')
  const args = ['5', '--review', join(dir, 'old.md'), '--approved-at', '2026-10-30T09:00:00Z']
  const r = run(github(), args)
  notCovered(r, /at 1234567\/bbbbbbb \(STALE\)/)
  assert.match(r.output, /^- review saw 1234567\/bbbbbbb, not aaaaaaa\/bbbbbbb$/m)
})

test('a review file without a head and base line is unknown and fails', () => {
  writeFileSync(join(dir, 'bare.md'), 'No findings.\n')
  notCovered(
    run(github(), ['5', '--review', join(dir, 'bare.md')]),
    /UNKNOWN: .*names no "Base <sha> → head <sha>"/,
  )
})

test('CI that failed on the current pair fails', () => {
  notCovered(run(github({ conclusion: 'failure' })), /CI 41 is completed\/failure/)
})

test('main moving past the base fails, listing the commits and files it gained', () => {
  const r = run(github({ main: NEWER, parents: [HEAD, BASE] }))
  notCovered(r, /main moved past the base by 1 commit/)
  assert.match(r.output, /main cccccc\w \(MOVED\)/)
  assert.match(r.output, /cccccc\w feat: something \(#4\)\n {2}files: packages\/db\/src\/x\.ts/)
  assert.match(r.output, /tested aaaaaaa into bbbbbbb, not the current head into main/)
})

test('CI logs without a tested merge commit are unknown and fail', () => {
  notCovered(
    run(github({ log: 'checkout of a branch\n' })),
    /UNKNOWN: CI 41's logs show no tested merge commit/,
  )
})

test('no CI run on the head is unknown and fails', () => {
  const answers = github()
  answers[CI_RUNS] = { workflow_runs: [] }
  notCovered(run(answers), /UNKNOWN: no ci\.yml run for #5 on aaaaaaa/)
})

test("a run of another workflow or branch on the same commit isn't taken as this PR's CI", () => {
  const answers = github()
  answers[CI_RUNS].workflow_runs[0].head_branch = 'other'
  notCovered(run(answers), /UNKNOWN: no ci\.yml run/)
})

test('without --approved-at, description edits are not assessed and the report still fails', () => {
  const r = run(github(), ['5', '--review', REVIEW])
  notCovered(r, /description edits after approval: not assessed/)
  assert.doesNotMatch(r.output, /edits after approval: 0/)
})

test('with --no-approval, a PR that needs no approval passes and the line says so', () => {
  const r = run(github(), ['5', '--review', REVIEW, '--no-approval'])
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /description edits after approval: n\/a \(approval not required\)$/m)
})

test('--no-approval with --approved-at is refused as a usage error', () => {
  const r = run(github(), [
    '5',
    '--review',
    REVIEW,
    '--no-approval',
    '--approved-at',
    '2026-10-30T09:00:00Z',
  ])
  assert.equal(r.status, 2, r.output)
  assert.match(r.output, /usage:/)
  const empty = run(github(), ['5', '--review', REVIEW, '--no-approval', '--approved-at='])
  assert.equal(empty.status, 2, empty.output)
  assert.match(empty.output, /usage:/)
})

test('description edits after the approval time are counted', () => {
  const edits = {
    totalCount: 2,
    nodes: [{ editedAt: '2026-10-30T08:00:00Z' }, { editedAt: '2026-10-30T11:00:00Z' }],
  }
  assert.match(run(github({ edits })).output, /description edits after approval: 1$/m)
})

test('governance files and modified or deleted tests are named; new tests are not', () => {
  const files = [
    { filename: '.github/workflows/ci.yml', status: 'modified' },
    { filename: 'apps/app/vitest.config.ts', status: 'modified' },
    { filename: 'scripts/check-bindings.mjs', status: 'modified' },
    { filename: 'apps/app/test/roles.test.ts', status: 'removed' },
    { filename: 'apps/app/test/new.test.ts', status: 'added' },
    { filename: 'apps/app/src/x.ts', status: 'modified' },
  ]
  assert.match(
    run(github({ files })).output,
    /governance: \.github\/workflows\/ci\.yml \(modified\), apps\/app\/vitest\.config\.ts \(modified\), scripts\/check-bindings\.mjs \(modified\), apps\/app\/test\/roles\.test\.ts \(removed\);/,
  )
})

test('a failed GitHub API call is unknown and fails', () => {
  const answers = github()
  delete answers[`${R}/pulls/5/files?per_page=100&page=1`]
  notCovered(run(answers), /governance: UNKNOWN \(.*HTTP 404/)
})

test("a fork's or another PR's green run on the same head and branch isn't taken as this PR's CI", () => {
  for (const other of [
    { head_repository: { full_name: 'fork/r' } },
    { pull_requests: [{ number: 99 }] },
  ]) {
    const answers = github()
    Object.assign(answers[CI_RUNS].workflow_runs[0], other)
    notCovered(run(answers), /UNKNOWN: no ci\.yml run for #5/)
  }
})

test("a merge line echoed by a step other than checkout isn't taken as the tested merge", () => {
  const log =
    `2026-10-30T10:00:00Z ##[group]Run echo "HEAD is now at e9e3dca Merge ${HEAD} into ${BASE}"\n` +
    `2026-10-30T10:00:01Z HEAD is now at e9e3dca Merge ${HEAD} into ${BASE}\n`
  notCovered(run(github({ log })), /UNKNOWN: CI 41's logs show no tested merge commit/)
})

test('an unreadable job log makes CI unknown, even when another job shows the merge', () => {
  const answers = github()
  delete answers[`${R}/actions/jobs/1/logs`]
  notCovered(run(answers), /CI UNKNOWN \(.*HTTP 404/)
})

test('jobs that tested different merges make CI unknown', () => {
  const answers = github()
  answers[`${R}/actions/jobs/1/logs`] = checkoutLog([HEAD, NEWER])
  notCovered(run(answers), /UNKNOWN: CI 41's jobs tested 2 different merges/)
})

test('a governance file or test renamed to an ordinary path is still named', () => {
  const files = [
    { filename: 'ordinary.txt', previous_filename: 'CLAUDE.md', status: 'renamed' },
    { filename: 'notes/x.md', previous_filename: 'apps/app/test/roles.test.ts', status: 'renamed' },
  ]
  assert.match(
    run(github({ files })).output,
    /governance: CLAUDE\.md → ordinary\.txt \(renamed\), apps\/app\/test\/roles\.test\.ts → notes\/x\.md \(renamed\);/,
  )
})

test("a PR argument that isn't a number is refused before any call", () => {
  const r = run({}, ['5;x', '--review', REVIEW])
  assert.equal(r.status, 2, r.output)
  assert.match(r.output, /usage:/)
})

test("the governance list matches review-pr step 5's", () => {
  const skill = readFileSync(
    new URL('../.agents/skills/review-pr/SKILL.md', import.meta.url),
    'utf8',
  )
  const step = skill.split('\n').find((l) => l.startsWith('5. **Governance:**'))
  assert.ok(step, 'review-pr SKILL.md has no "5. **Governance:**" line')
  const listed = [...step.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  assert.ok(listed.length > 5, `extracted only ${listed.length} paths from step 5`)
  assert.deepEqual(GOVERNANCE, listed)
  assert.match(step, /modified or deleted tests/)
})
