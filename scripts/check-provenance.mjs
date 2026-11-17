#!/usr/bin/env node
// Checks that every commit on main is a squash merge of a pull request whose CI had passed on its
// final head when it merged (provenance.yml, on each push to main and daily). It detects pushes the
// permission rules miss (docs/runbooks/start-new-product.md step 9); it blocks nothing, a failed
// run is the alert.
// Checked commits: main's first-parent history from the tip back to the commit the previous
// finished provenance run checked (at most 20), so a push that started no run (`[skip ci]` in its message)
// is checked by the next push or the daily run. Fails when
//   - on a push: it was forced, holds other than one commit, or the commit's parent isn't `before`;
//   - the previous run's commit isn't within the last 20 of main's history (rewritten or too many);
//   - a checked commit has more than one parent, or no merged pull request into main has it as
//     its merge commit;
//   - CI (ci.yml) on that PR's final head, as it stood at merged_at, wasn't green: of every
//     attempt of every run whose jobs had all completed by merged_at, the last to complete
//     decides. Reruns after the merge are ignored, so they can't clear or create a violation.
// Exit 0: every commit checked, none broke the rule. Exit 3: the check ran to its end and reported
// at least one violation. Any other status (a failed API call, a crash): the check didn't finish,
// and its commits stay unchecked. provenance.yml turns a 3 into a passed "Check provenance" step
// and a failed next step, so a later run can tell the two failures apart (previousHead).
// Two violations leave commits that no run checks, and their messages say so: a force-push (none
// of its commits) and a previous commit outside the last 20 (the older ones). The next run starts
// after them all the same: there is no way to reset the starting point by hand, so failing closed
// would fail every later run.
// Reads GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA, GITHUB_RUN_ID and GITHUB_REPOSITORY;
// calls `gh api` (GH_TOKEN).
// Usage: node scripts/check-provenance.mjs
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const LOOKBACK = 20
const VIOLATION = 3
// The step in provenance.yml that runs this script (check-provenance.test.mjs keeps the names equal).
const CHECK_STEP = 'Check provenance'
const repo = process.env.GITHUB_REPOSITORY
const tip = process.env.GITHUB_SHA
const event =
  process.env.GITHUB_EVENT_NAME === 'push'
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : null
// The list of provenance runs passed execFileSync's 1 MiB default at 82 runs (ENOBUFS, 2026-11-16).
const api = (path) =>
  JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))

function checkPush() {
  if (event.forced)
    return [
      `${event.after} was force-pushed to main; its commits weren't checked, and later runs start after it: check them by hand`,
    ]
  const errors = []
  if (event.commits?.length !== 1)
    errors.push(
      `the push to main holds ${event.commits?.length ?? 0} commits; a squash merge holds 1`,
    )
  const { parents } = api(`repos/${repo}/commits/${event.after}`)
  if (parents[0]?.sha !== event.before)
    errors.push(
      `${event.after}'s parent ${parents[0]?.sha} isn't the previous main ${event.before}`,
    )
  return errors
}

/** Whether a failed run finished checking: its check step passed and a violation failed the run. */
function finishedChecking(id) {
  const { jobs } = api(`repos/${repo}/actions/runs/${id}/jobs`)
  return jobs.some((j) => j.steps?.some((s) => s.name === CHECK_STEP && s.conclusion === 'success'))
}

/**
 * Where this run stops walking main's history: `{ sha, checked }`, or null for the first run.
 * `checked: true` is the commit the latest earlier run finished checking: a success, or a failure
 * whose check step passed (it reported a violation and already alerted). A run that failed before
 * it finished (an API error, a crash, a timeout), or was cancelled, skipped or is unfinished,
 * checked nothing: its commits are checked now. When no earlier run finished, `checked: false` is
 * the oldest earlier run's commit, which is checked too: that run, as the first, owed only its tip.
 */
function previousHead() {
  const own = Number(process.env.GITHUB_RUN_ID)
  let oldestUnfinished = null
  for (let page = 1; page <= 10; page++) {
    const { workflow_runs } = api(
      `repos/${repo}/actions/workflows/provenance.yml/runs?branch=main&per_page=100&page=${page}`,
    )
    if (!workflow_runs.length) return oldestUnfinished && { sha: oldestUnfinished, checked: false }
    for (const r of workflow_runs) {
      if (r.id >= own) continue
      const finished =
        r.status === 'completed' &&
        (r.conclusion === 'success' || (r.conclusion === 'failure' && finishedChecking(r.id)))
      if (finished) return { sha: r.head_sha, checked: true }
      oldestUnfinished = r.head_sha
    }
  }
  throw new Error('no finished provenance run in the latest 1,000; check by hand')
}

/**
 * Main's first-parent commits from the tip back to `previous.sha`, at most LOOKBACK: that commit
 * is left out when an earlier run checked it, and is the last one included when none did.
 */
function commitsSince(previous) {
  const stop = previous?.sha
  const commits = []
  for (let sha = tip; sha && (sha !== stop || !previous.checked);) {
    if (commits.length === LOOKBACK)
      return {
        commits,
        error: `the previous run's commit ${stop} isn't in main's last ${LOOKBACK} commits (history rewritten, or more unchecked commits); older commits weren't checked, and later runs start after ${tip}: check them by hand`,
      }
    const { parents } = api(`repos/${repo}/commits/${sha}`)
    commits.push({ sha, parents })
    if (!stop || sha === stop) break
    sha = parents[0]?.sha
  }
  return { commits, error: null }
}

/** The merged PR into main whose merge commit is sha; the association can lag the push. */
async function pullRequestOf(sha) {
  for (let i = 0; ; i++) {
    const pr = api(`repos/${repo}/commits/${sha}/pulls`).find(
      (p) => p.merged_at && p.base.ref === 'main' && p.merge_commit_sha === sha,
    )
    if (pr || i === 2) return pr
    await sleep(Number(process.env.PROVENANCE_RETRY_MS ?? 10_000))
  }
}

/** CI's state on head at time `at`: the last attempt whose jobs had all completed by then. */
function ciAt(head, at) {
  const runs = api(
    `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request&per_page=100`,
  )
  if (runs.total_count > 100) throw new Error(`${runs.total_count} CI runs on ${head}; read 100`)
  let last = null
  for (const run of runs.workflow_runs)
    for (let n = 1; n <= run.run_attempt; n++) {
      const base = `repos/${repo}/actions/runs/${run.id}/attempts/${n}`
      // A "re-run failed jobs" attempt also lists the jobs it carried over, with their old times.
      const { jobs } = api(`${base}/jobs?per_page=100`)
      if (!jobs.length || jobs.some((j) => !j.completed_at)) continue
      const completed = Math.max(...jobs.map((j) => Date.parse(j.completed_at)))
      if (completed > at || (last && completed <= last.completed)) continue
      last = { completed, url: run.html_url, attempt: n, conclusion: api(base).conclusion }
    }
  return last
}

async function checkCommit({ sha, parents }) {
  if (parents.length !== 1) return `${sha} has ${parents.length} parents; not a squash merge`
  const pr = await pullRequestOf(sha)
  if (!pr) return `no merged pull request into main has ${sha} as its merge commit`
  const ci = ciAt(pr.head.sha, Date.parse(pr.merged_at))
  if (!ci) return `${sha}: #${pr.number} merged with no completed CI run on its head ${pr.head.sha}`
  if (ci.conclusion !== 'success')
    return `${sha}: #${pr.number} merged while CI on its head ${pr.head.sha} was ${ci.conclusion} (${ci.url}, attempt ${ci.attempt})`
  console.log(`check-provenance: ${sha} is #${pr.number}, CI green on ${pr.head.sha}`)
  return null
}

async function main() {
  const errors = event ? checkPush() : []
  if (event?.forced) return errors
  const { commits, error } = commitsSince(previousHead())
  if (error) errors.push(error)
  for (const c of commits) {
    const e = await checkCommit(c)
    if (e) errors.push(e)
  }
  if (!errors.length) console.log(`check-provenance: ok, ${commits.length} commit(s) up to ${tip}`)
  return errors
}

let errors
let status = VIOLATION
try {
  errors = await main()
} catch (e) {
  // One line, so the whole message stays in the ::error:: annotation.
  errors = [`couldn't check ${tip}: ${e.message.replace(/\s+/g, ' ').trim()}`]
  status = 1
}
for (const e of errors) console.error(`::error::check-provenance: ${e}`)
if (errors.length && process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, errors.map((e) => `- ${e}\n`).join(''))
if (errors.length) process.exit(status)
