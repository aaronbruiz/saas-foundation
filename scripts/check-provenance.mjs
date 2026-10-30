#!/usr/bin/env node
// Checks that every commit on main is a squash merge of a pull request whose CI had passed on its
// final head when it merged (provenance.yml, on each push to main and daily). It detects pushes the
// permission rules miss (docs/runbooks/start-new-product.md step 9); it blocks nothing, a failed
// run is the alert.
// Checked commits: main's first-parent history from the tip back to the commit the previous
// provenance run checked (at most 20), so a push that started no run (`[skip ci]` in its message)
// is checked by the next push or the daily run. Fails when
//   - on a push: it was forced, holds other than one commit, or the commit's parent isn't `before`;
//   - the previous run's commit isn't within the last 20 of main's history (rewritten or too many);
//   - a checked commit has more than one parent, or no merged pull request into main has it as
//     its merge commit;
//   - CI (ci.yml) on that PR's final head, as it stood at merged_at, wasn't green: of every
//     attempt of every run whose jobs had all completed by merged_at, the last to complete
//     decides. Reruns after the merge are ignored, so they can't clear or create a violation.
// A failed API call fails too. Reads GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA,
// GITHUB_RUN_ID and GITHUB_REPOSITORY; calls `gh api` (GH_TOKEN).
// Usage: node scripts/check-provenance.mjs
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const LOOKBACK = 20
const repo = process.env.GITHUB_REPOSITORY
const tip = process.env.GITHUB_SHA
const event =
  process.env.GITHUB_EVENT_NAME === 'push'
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : null
const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))

function checkPush() {
  if (event.forced) return [`${event.after} was force-pushed to main`]
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

/** The commit the latest earlier provenance run checked, or null for the first run. */
function previousHead() {
  const { workflow_runs } = api(
    `repos/${repo}/actions/workflows/provenance.yml/runs?branch=main&per_page=10`,
  )
  return workflow_runs.find((r) => r.id < Number(process.env.GITHUB_RUN_ID))?.head_sha ?? null
}

/** Main's first-parent commits from the tip back to `stop` (excluded), at most LOOKBACK. */
function commitsSince(stop) {
  const commits = []
  for (let sha = tip; sha && sha !== stop;) {
    if (commits.length === LOOKBACK)
      return {
        commits,
        error: `the previously checked commit ${stop} isn't in main's last ${LOOKBACK} commits (history rewritten, or more unchecked commits)`,
      }
    const { parents } = api(`repos/${repo}/commits/${sha}`)
    commits.push({ sha, parents })
    if (!stop) break
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
try {
  errors = await main()
} catch (e) {
  // One line, so the whole message stays in the ::error:: annotation.
  errors = [`couldn't check ${tip}: ${e.message.replace(/\s+/g, ' ').trim()}`]
}
for (const e of errors) console.error(`::error::check-provenance: ${e}`)
if (errors.length && process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, errors.map((e) => `- ${e}\n`).join(''))
if (errors.length) process.exit(1)
