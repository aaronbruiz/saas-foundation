// Runs check-provenance.mjs against a fake `gh` on PATH that answers `gh api <path>` from a
// fixture map, so the policy is tested without a token or GitHub.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = new URL('./check-provenance.mjs', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'check-provenance-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// Prints FAKE_GH[path] as JSON; an unknown path fails like a 404.
writeFileSync(
  join(dir, 'gh'),
  `#!/usr/bin/env node
const [cmd, path] = process.argv.slice(2)
const answers = JSON.parse(process.env.FAKE_GH)
if (cmd !== 'api' || !(path in answers)) { console.error('gh: HTTP 404: ' + path); process.exit(1) }
process.stdout.write(JSON.stringify(answers[path]))
`,
)
chmodSync(join(dir, 'gh'), 0o755)

const R = 'repos/o/r'
const SHA = 'c0ffee'
const PREV = 'beef00'
const HEAD = 'feed01'
const MERGED = '2026-10-30T12:00:00Z'

const job = (completed_at) => ({ completed_at })
/** A CI run on HEAD with attempts: [{ conclusion, completed }] (completed: ISO time or null). */
function ciRun(id, attempts) {
  const answers = {}
  attempts.forEach(({ conclusion, completed }, i) => {
    const base = `${R}/actions/runs/${id}/attempts/${i + 1}`
    answers[base] = { conclusion }
    answers[`${base}/jobs?per_page=100`] = { jobs: [job('2026-10-30T11:00:00Z'), job(completed)] }
  })
  return { run: { id, run_attempt: attempts.length, html_url: `https://ci/${id}` }, answers }
}

/** GitHub's answers for a squash merge of PR #7 (head HEAD) at MERGED, with these CI runs. */
function github({
  runs = [ciRun(1, [{ conclusion: 'success', completed: '2026-10-30T11:50:00Z' }])],
  parents = [{ sha: PREV }],
  pulls,
} = {}) {
  return {
    [`${R}/commits/${SHA}`]: { parents },
    [`${R}/commits/${SHA}/pulls`]: pulls ?? [
      {
        number: 7,
        merged_at: MERGED,
        merge_commit_sha: SHA,
        base: { ref: 'main' },
        head: { sha: HEAD },
      },
    ],
    [`${R}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&event=pull_request&per_page=100`]: {
      total_count: runs.length,
      workflow_runs: runs.map((r) => r.run),
    },
    ...Object.assign({}, ...runs.map((r) => r.answers)),
  }
}

const pushEvent = { after: SHA, before: PREV, forced: false, commits: [{ id: SHA }] }

function run(answers, event = pushEvent) {
  const path = join(dir, `event-${Math.random()}.json`)
  writeFileSync(path, JSON.stringify(event))
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_GH: JSON.stringify(answers),
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_PATH: path,
      GITHUB_STEP_SUMMARY: '',
      PROVENANCE_RETRY_MS: '1',
    },
  })
  return { status: r.status, output: r.stdout + r.stderr }
}

function fails(r, pattern) {
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, pattern)
  assert.doesNotMatch(r.output, /check-provenance: ok/)
}

test('a squash merge of a PR whose CI passed on its final head before the merge passes', () => {
  const r = run(github())
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /check-provenance: ok, c0ffee is #7/)
})

test('a force-push to main fails', () => {
  fails(run(github(), { ...pushEvent, forced: true }), /force-pushed/)
})

test('a push of two commits to main fails', () => {
  fails(run(github(), { ...pushEvent, commits: [{ id: 'a' }, { id: SHA }] }), /holds 2 commits/)
})

test('a merge commit with two parents fails', () => {
  fails(run(github({ parents: [{ sha: PREV }, { sha: HEAD }] })), /2 parents; not a squash/)
})

test("a commit whose parent isn't the previous main fails", () => {
  fails(run(github({ parents: [{ sha: 'other' }] })), /isn't the previous main/)
})

test('a direct push that no merged PR points at fails', () => {
  const unmerged = {
    number: 8,
    merged_at: null,
    merge_commit_sha: SHA,
    base: { ref: 'main' },
    head: { sha: HEAD },
  }
  fails(run(github({ pulls: [unmerged] })), /no merged pull request into main/)
})

test('a PR merged before its CI on the final head completed fails', () => {
  const late = ciRun(1, [{ conclusion: 'success', completed: '2026-10-30T12:05:00Z' }])
  fails(run(github({ runs: [late] })), /#7 merged with no completed CI run/)
})

test('a PR merged while a CI job was still running fails', () => {
  const running = ciRun(1, [{ conclusion: null, completed: null }])
  fails(run(github({ runs: [running] })), /#7 merged with no completed CI run/)
})

test('a PR merged after its CI failed fails, even when a rerun after the merge passed', () => {
  const rerun = ciRun(1, [
    { conclusion: 'failure', completed: '2026-10-30T11:50:00Z' },
    { conclusion: 'success', completed: '2026-10-30T12:30:00Z' },
  ])
  fails(run(github({ runs: [rerun] })), /was failure \(https:\/\/ci\/1, attempt 1\)/)
})

test('a PR whose CI passed before the merge passes, even when a rerun after the merge failed', () => {
  const rerun = ciRun(1, [
    { conclusion: 'success', completed: '2026-10-30T11:50:00Z' },
    { conclusion: 'failure', completed: '2026-10-30T12:30:00Z' },
  ])
  assert.equal(run(github({ runs: [rerun] })).status, 0)
})

test('the CI attempt completed last before the merge decides between runs', () => {
  const passed = ciRun(1, [{ conclusion: 'success', completed: '2026-10-30T11:40:00Z' }])
  const failed = ciRun(2, [{ conclusion: 'failure', completed: '2026-10-30T11:55:00Z' }])
  fails(run(github({ runs: [passed, failed] })), /was failure \(https:\/\/ci\/2/)
  assert.equal(
    run(
      github({
        runs: [failed, ciRun(3, [{ conclusion: 'success', completed: '2026-10-30T11:58:00Z' }])],
      }),
    ).status,
    0,
  )
})

test('a failed GitHub API call fails the check', () => {
  const answers = github()
  delete answers[`${R}/commits/${SHA}`]
  fails(run(answers), /couldn't check c0ffee: .*HTTP 404/)
})
