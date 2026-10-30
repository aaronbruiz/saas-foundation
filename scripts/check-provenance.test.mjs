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
const MERGED = '2026-10-30T12:00:00Z'
const GREEN = [{ conclusion: 'success', completed: '2026-10-30T11:50:00Z' }]

const job = (completed_at) => ({ completed_at })

/** Answers for a CI run with attempts [{ conclusion, completed }] (completed: ISO time or null). */
function ciAnswers(id, attempts) {
  const answers = {}
  attempts.forEach(({ conclusion, completed }, i) => {
    const base = `${R}/actions/runs/${id}/attempts/${i + 1}`
    answers[base] = { conclusion }
    answers[`${base}/jobs?per_page=100`] = { jobs: [job('2026-10-30T11:00:00Z'), job(completed)] }
  })
  return { run: { id, run_attempt: attempts.length, html_url: `https://ci/${id}` }, answers }
}

/**
 * GitHub's answers for main's commits, tip first: each { sha, parents, pr, runs }, where pr is
 * the PR number merged as that commit (null for none) and runs its CI runs' attempts. The last
 * commit's parent is `previous`, the commit the previous provenance run checked.
 */
function github(commits, { previous = PREV, provenanceRuns } = {}) {
  const answers = {
    [`${R}/actions/workflows/provenance.yml/runs?branch=main&per_page=10`]: {
      workflow_runs: provenanceRuns ?? (previous ? [{ id: 99, head_sha: previous }] : []),
    },
  }
  commits.forEach(({ sha, parents, pr = 7, runs = [GREEN] }, i) => {
    const head = `head-${sha}`
    answers[`${R}/commits/${sha}`] = {
      parents: parents ?? [{ sha: commits[i + 1]?.sha ?? previous ?? 'older' }],
    }
    answers[`${R}/commits/${sha}/pulls`] = pr
      ? [
          {
            number: pr,
            merged_at: MERGED,
            merge_commit_sha: sha,
            base: { ref: 'main' },
            head: { sha: head },
          },
        ]
      : []
    const ci = runs.map((attempts, j) => ciAnswers(`${sha}-${j}`, attempts))
    answers[`${R}/actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request&per_page=100`] =
      {
        total_count: ci.length,
        workflow_runs: ci.map((r) => r.run),
      }
    Object.assign(answers, ...ci.map((r) => r.answers))
  })
  return answers
}

const pushEvent = { after: SHA, before: PREV, forced: false, commits: [{ id: SHA }] }

function run(answers, { event = pushEvent, name = 'push', tip = SHA } = {}) {
  const path = join(dir, `event-${Math.random()}.json`)
  writeFileSync(path, JSON.stringify(event))
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_GH: JSON.stringify(answers),
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_NAME: name,
      GITHUB_EVENT_PATH: path,
      GITHUB_SHA: tip,
      GITHUB_RUN_ID: '100',
      GITHUB_STEP_SUMMARY: '',
      PROVENANCE_RETRY_MS: '1',
    },
  })
  return { status: r.status, output: r.stdout + r.stderr }
}

function passes(r) {
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /check-provenance: ok/)
}

function fails(r, pattern) {
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, pattern)
  assert.doesNotMatch(r.output, /check-provenance: ok/)
}

test('a squash merge of a PR whose CI passed on its final head before the merge passes', () => {
  const r = run(github([{ sha: SHA }]))
  passes(r)
  assert.match(r.output, /c0ffee is #7/)
})

test('a force-push to main fails', () => {
  fails(run(github([{ sha: SHA }]), { event: { ...pushEvent, forced: true } }), /force-pushed/)
})

test('a push of two commits to main fails', () => {
  const answers = github([{ sha: SHA }, { sha: 'a1' }])
  fails(
    run(answers, { event: { ...pushEvent, commits: [{ id: 'a1' }, { id: SHA }] } }),
    /holds 2 commits/,
  )
})

test('a merge commit with two parents fails', () => {
  fails(
    run(github([{ sha: SHA, parents: [{ sha: PREV }, { sha: 'side' }] }])),
    /2 parents; not a squash/,
  )
})

test("a pushed commit whose parent isn't the previous main fails", () => {
  fails(
    run(github([{ sha: SHA }]), { event: { ...pushEvent, before: 'other' } }),
    /isn't the previous main/,
  )
})

test('a direct push that no merged PR points at fails', () => {
  fails(run(github([{ sha: SHA, pr: null }])), /no merged pull request into main has c0ffee/)
})

test('a PR merged before its CI on the final head completed fails', () => {
  const late = [{ conclusion: 'success', completed: '2026-10-30T12:05:00Z' }]
  fails(run(github([{ sha: SHA, runs: [late] }])), /#7 merged with no completed CI run/)
})

test('a PR merged while a CI job was still running fails', () => {
  const running = [{ conclusion: null, completed: null }]
  fails(run(github([{ sha: SHA, runs: [running] }])), /#7 merged with no completed CI run/)
})

test('a PR merged after its CI failed fails, even when a rerun after the merge passed', () => {
  const rerun = [
    { conclusion: 'failure', completed: '2026-10-30T11:50:00Z' },
    { conclusion: 'success', completed: '2026-10-30T12:30:00Z' },
  ]
  fails(
    run(github([{ sha: SHA, runs: [rerun] }])),
    /was failure \(https:\/\/ci\/c0ffee-0, attempt 1\)/,
  )
})

test('a PR whose CI passed before the merge passes, even when a rerun after the merge failed', () => {
  const rerun = [
    { conclusion: 'success', completed: '2026-10-30T11:50:00Z' },
    { conclusion: 'failure', completed: '2026-10-30T12:30:00Z' },
  ]
  passes(run(github([{ sha: SHA, runs: [rerun] }])))
})

test('the CI attempt completed last before the merge decides between runs', () => {
  const passed = [{ conclusion: 'success', completed: '2026-10-30T11:40:00Z' }]
  const failed = [{ conclusion: 'failure', completed: '2026-10-30T11:55:00Z' }]
  const later = [{ conclusion: 'success', completed: '2026-10-30T11:58:00Z' }]
  fails(run(github([{ sha: SHA, runs: [passed, failed] }])), /was failure \(https:\/\/ci\/c0ffee-1/)
  passes(run(github([{ sha: SHA, runs: [failed, later] }])))
})

test('a direct push that started no run is caught by the next push', () => {
  const answers = github([{ sha: SHA }, { sha: 'skipped', pr: null }])
  const r = run(answers, { event: { ...pushEvent, before: 'skipped' } })
  fails(r, /no merged pull request into main has skipped/)
  assert.match(r.output, /c0ffee is #7/)
})

test('the daily run checks the commits since the previous run and passes when they are green', () => {
  const r = run(github([{ sha: SHA }, { sha: 'b2', pr: 6 }]), { name: 'schedule', event: {} })
  passes(r)
  assert.match(r.output, /2 commit\(s\)/)
})

test('the daily run with no new commit since the previous run checks nothing and passes', () => {
  passes(run(github([], { previous: SHA }), { name: 'schedule', event: {} }))
})

test('the daily run catches a direct push that started no run', () => {
  fails(
    run(github([{ sha: SHA, pr: null }]), { name: 'schedule', event: {} }),
    /no merged pull request/,
  )
})

test("a previously checked commit that's gone from main's history fails", () => {
  const chain = Array.from({ length: 20 }, (_, i) => ({ sha: `n${i}` }))
  chain[19].parents = [{ sha: 'unrelated' }]
  const r = run(github(chain, { previous: 'rewritten' }), {
    name: 'schedule',
    event: {},
    tip: 'n0',
  })
  fails(r, /previously checked commit rewritten isn't in main's last 20 commits/)
})

test('the first run checks only the tip', () => {
  const answers = github([{ sha: SHA, parents: [{ sha: 'old-unchecked' }] }], { previous: null })
  const r = run(answers, { event: { ...pushEvent, before: 'old-unchecked' } })
  passes(r)
  assert.match(r.output, /1 commit\(s\)/)
})

test('the check ignores its own run when finding the previous one', () => {
  const answers = github([{ sha: SHA }], {
    provenanceRuns: [
      { id: 100, head_sha: SHA },
      { id: 99, head_sha: PREV },
    ],
  })
  const r = run(answers)
  passes(r)
  assert.match(r.output, /1 commit\(s\)/)
})

test('a failed GitHub API call fails the check', () => {
  const answers = github([{ sha: SHA }])
  delete answers[`${R}/commits/${SHA}`]
  fails(run(answers), /couldn't check c0ffee: .*HTTP 404/)
})
