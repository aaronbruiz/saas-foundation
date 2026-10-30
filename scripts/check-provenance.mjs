#!/usr/bin/env node
// Checks, after a push to main, that it is a squash merge of a pull request whose CI had passed on
// its final head when it merged (provenance.yml). It detects pushes the permission rules miss
// (docs/runbooks/start-new-product.md step 9); it blocks nothing, a failed run is the alert.
// Fails when
//   - the push was forced, or holds other than one commit;
//   - the commit has more than one parent, or its parent isn't the previous main;
//   - no merged pull request into main has the commit as its merge commit;
//   - CI (ci.yml) on that PR's final head, as it stood at merged_at, wasn't green: of every
//     attempt of every run whose jobs had all completed by merged_at, the last to complete
//     decides. Reruns after the merge are ignored, so they can't clear or create a violation.
// A failed API call fails too. Reads the push event (GITHUB_EVENT_PATH) and GITHUB_REPOSITORY;
// calls `gh api` (GH_TOKEN). Usage: node scripts/check-provenance.mjs
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const repo = process.env.GITHUB_REPOSITORY
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))

function check() {
  const sha = event.after
  if (event.forced) return [`${sha} was force-pushed to main`]
  if (event.commits?.length !== 1)
    return [`the push to main holds ${event.commits?.length ?? 0} commits; a squash merge holds 1`]
  const { parents } = api(`repos/${repo}/commits/${sha}`)
  if (parents.length !== 1) return [`${sha} has ${parents.length} parents; not a squash merge`]
  if (parents[0].sha !== event.before)
    return [`${sha}'s parent ${parents[0].sha} isn't the previous main ${event.before}`]
  return null
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
      const { jobs } = api(`${base}/jobs?per_page=100`)
      if (!jobs.length || jobs.some((j) => !j.completed_at)) continue
      const completed = Math.max(...jobs.map((j) => Date.parse(j.completed_at)))
      if (completed > at || (last && completed <= last.completed)) continue
      last = { completed, url: run.html_url, attempt: n, conclusion: api(base).conclusion }
    }
  return last
}

async function main() {
  const sha = event.after
  const early = check()
  if (early) return early
  const pr = await pullRequestOf(sha)
  if (!pr) return [`no merged pull request into main has ${sha} as its merge commit`]
  const ci = ciAt(pr.head.sha, Date.parse(pr.merged_at))
  if (!ci) return [`#${pr.number} merged with no completed CI run on its head ${pr.head.sha}`]
  if (ci.conclusion !== 'success')
    return [
      `#${pr.number} merged while CI on its head ${pr.head.sha} was ${ci.conclusion} (${ci.url}, attempt ${ci.attempt})`,
    ]
  console.log(`check-provenance: ok, ${sha} is #${pr.number}, CI green on ${pr.head.sha}`)
  return []
}

let errors
try {
  errors = await main()
} catch (e) {
  // One line, so the whole message stays in the ::error:: annotation.
  errors = [`couldn't check ${event.after}: ${e.message.replace(/\s+/g, ' ').trim()}`]
}
for (const e of errors) console.error(`::error::check-provenance: ${e}`)
if (errors.length && process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, errors.map((e) => `- ${e}\n`).join(''))
if (errors.length) process.exit(1)
