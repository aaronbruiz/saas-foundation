#!/usr/bin/env node
// Prints CLAUDE.md's evidence line for a pull request into main, from GitHub's current state, and
// exits 1 unless the evidence covers the PR's current head with GitHub's current main: the review
// file's head and base, CI (ci.yml, on this PR's head) green on a merge of the head into the
// current main, main not moved past the PR's base. Anything it can't read or match is UNKNOWN and
// fails too. Read-only: GitHub API GETs through `gh api`, and the review file.
// It checks that the evidence is fresh. It doesn't establish the owner's approval or authorize a
// merge. Governance files: GOVERNANCE below, the list in review-pr step 5 (the test checks they
// match). Description edits after approval need --approved-at; without it they're "not assessed".
// Usage: node scripts/merge-readiness.mjs <pr> --review <result file> [--approved-at <ISO time>]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** review-pr step 5's governance paths (`*` within a segment, `**` across segments). */
export const GOVERNANCE = [
  '.github/workflows/**',
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/settings.json',
  '.claude/agents/**',
  '.claude/hooks/**',
  '.agents/skills/**',
  'scripts/check-*',
  'scripts/test-lock.sh',
  'eslint.config.js',
  'apps/app/vitest*.config.ts',
  'apps/app/playwright.config.ts',
  '.github/pull_request_template.md',
]
const TEST = /(\.test\.[cm]?[jt]sx?$|^apps\/app\/(test|e2e)\/)/

const glob = (pattern) =>
  new RegExp(
    `^${pattern
      .split('**')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'))
      .join('.*')}$`,
  )
/** A governance file or a modified, removed or renamed test, under its new or (renamed) old path. */
const governed = (f) =>
  [f.filename, f.previous_filename].some(
    (name) =>
      name &&
      (GOVERNANCE.some((p) => glob(p).test(name)) || (TEST.test(name) && f.status !== 'added')),
  )

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
const api = (path) => JSON.parse(gh(['api', path]))
const short = (sha) => sha?.slice(0, 7)

/** Every item of a paged list endpoint (per_page=100). */
function all(path, key) {
  const items = []
  for (let page = 1; ; page++) {
    const body = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    const batch = key ? body[key] : body
    items.push(...batch)
    if (batch.length < 100) return items
  }
}

/** Runs one evidence item; an error makes it UNKNOWN instead of stopping the report. */
function item(problems, fn) {
  try {
    return fn()
  } catch (e) {
    const why = e.message.replace(/\s+/g, ' ').trim()
    problems.push(`UNKNOWN: ${why}`)
    return `UNKNOWN (${why})`
  }
}

/** Head and base of the review file's first line ("Base `x` → head `y`", review-pr's output). */
function reviewed(file) {
  const first = readFileSync(file, 'utf8').split('\n', 1)[0]
  const m = first.match(/base\W+([0-9a-f]{7,40})\W+(?:→|->)\s*head\W+([0-9a-f]{7,40})/i)
  if (!m) throw new Error(`${file}'s first line names no "Base <sha> → head <sha>"`)
  return { base: m[1], head: m[2] }
}

/** The merges a job log's actions/checkout steps report (other steps' output doesn't count). */
function checkedOut(log) {
  const merges = []
  for (const step of log.split(/^\S+ ##\[group\]Run /m).slice(1)) {
    if (!step.startsWith('actions/checkout@')) continue
    for (const m of step.matchAll(
      /^\S+ HEAD is now at ([0-9a-f]+) Merge ([0-9a-f]{40}) into ([0-9a-f]{40})$/gm,
    ))
      merges.push({ merge: m[1], parents: [m[2], m[3]] })
  }
  return merges
}

/**
 * The newest ci.yml run for this PR's head (same repository and branch; when GitHub lists the
 * run's PRs, this one among them) and the one merge its checkouts tested. An unreadable log, or
 * jobs that tested different merges, make it unknown.
 */
function ci(pr) {
  const runs = all(
    `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&event=pull_request`,
    'workflow_runs',
  ).filter(
    (r) =>
      r.path === '.github/workflows/ci.yml' &&
      r.head_branch === pr.head.ref &&
      r.head_repository?.full_name === pr.head.repo?.full_name &&
      (!r.pull_requests?.length || r.pull_requests.some((p) => p.number === pr.number)),
  )
  if (!runs.length) throw new Error(`no ci.yml run for #${pr.number} on ${short(pr.head.sha)}`)
  const run = runs.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a))
  const merges = new Map()
  for (const job of api(`repos/{owner}/{repo}/actions/runs/${run.id}/jobs`).jobs) {
    if (job.conclusion === 'skipped') continue
    const log = gh(['api', `repos/{owner}/{repo}/actions/jobs/${job.id}/logs`])
    for (const m of checkedOut(log)) merges.set(m.parents.join(), m)
  }
  if (merges.size > 1) throw new Error(`CI ${run.id}'s jobs tested ${merges.size} different merges`)
  if (!merges.size) throw new Error(`CI ${run.id}'s logs show no tested merge commit`)
  return { run, ...[...merges.values()][0] }
}

function edits(n, approvedAt, problems) {
  if (!approvedAt) {
    problems.push('description edits after approval not assessed: pass --approved-at')
    return 'not assessed (no --approved-at)'
  }
  const at = Date.parse(approvedAt)
  if (Number.isNaN(at)) throw new Error(`--approved-at ${approvedAt} isn't a time`)
  const query = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){userContentEdits(first:100){totalCount nodes{editedAt}}}}}`
  const res = JSON.parse(
    gh([
      'api',
      'graphql',
      '-F',
      'owner={owner}',
      '-F',
      'name={repo}',
      '-F',
      `n=${n}`,
      '-f',
      `query=${query}`,
    ]),
  )
  const e = res.data.repository.pullRequest.userContentEdits
  if (e.totalCount > e.nodes.length) throw new Error(`${e.totalCount} description edits; read 100`)
  return String(e.nodes.filter((x) => Date.parse(x.editedAt) > at).length)
}

function report(n, { review, approvedAt }) {
  const problems = []
  const line = []
  const pr = api(`repos/{owner}/{repo}/pulls/${n}`)
  if (pr.base.ref !== 'main')
    throw new Error(`#${n} targets ${pr.base.ref}; this covers PRs into main`)
  if (pr.state !== 'open') problems.push(`#${n} is ${pr.merged_at ? 'merged' : pr.state}`)
  const head = pr.head.sha
  const main = api('repos/{owner}/{repo}/git/ref/heads/main').object.sha
  const cmp = api(`repos/{owner}/{repo}/compare/${main}...${head}`)
  const base = cmp.merge_base_commit.sha
  line.push(`head ${short(head)}`, `base ${short(base)}`)

  line.push(
    `review ${item(problems, () => {
      const r = reviewed(review)
      const fresh = head.startsWith(r.head) && base.startsWith(r.base)
      if (!fresh) problems.push(`review saw ${r.head}/${r.base}, not ${short(head)}/${short(base)}`)
      return `${review} at ${r.head}/${r.base}${fresh ? '' : ' (STALE)'}`
    })}`,
  )

  line.push(
    `CI ${item(problems, () => {
      const c = ci(pr)
      const pair = c.parents[0] === head && c.parents[1] === main
      if (c.run.conclusion !== 'success')
        problems.push(`CI ${c.run.id} is ${c.run.status}/${c.run.conclusion ?? 'none'}`)
      if (!pair)
        problems.push(
          `CI ${c.run.id} tested ${short(c.parents[0])} into ${short(c.parents[1])}, not the current head into main`,
        )
      return `${c.run.id} tested ${c.merge} (parents ${short(c.parents[0])}, ${short(c.parents[1])}), ${c.run.conclusion ?? c.run.status}`
    })}`,
  )

  let moved = ''
  if (main !== base) {
    const since = api(`repos/{owner}/{repo}/compare/${base}...${main}`)
    problems.push(`main moved past the base by ${since.ahead_by} commit(s)`)
    moved =
      `\nmain gained since ${short(base)}:\n` +
      since.commits
        .map((c) => `  ${short(c.sha)} ${c.commit.message.split('\n', 1)[0]}`)
        .join('\n') +
      `\n  files: ${since.files.map((f) => f.filename).join(', ')}` +
      // The compare API lists at most 250 commits and 300 files.
      (since.ahead_by > since.commits.length || since.files.length >= 300
        ? `\n  (truncated: see git log ${short(base)}..${short(main)})`
        : '')
  }
  line.push(`main ${short(main)}${main === base ? '' : ' (MOVED)'}`)

  line.push(
    `governance: ${item(problems, () => {
      const files = all(`repos/{owner}/{repo}/pulls/${n}/files`)
      if (files.length >= 3000) throw new Error('the PR files API stops at 3,000 files')
      return (
        files
          .filter(governed)
          .map(
            (f) =>
              `${f.previous_filename ? `${f.previous_filename} → ` : ''}${f.filename}${f.status === 'added' ? '' : ` (${f.status})`}`,
          )
          .join(', ') || 'none'
      )
    })}`,
  )
  line.push(
    `description edits after approval: ${item(problems, () => edits(n, approvedAt, problems))}`,
  )

  console.log(line.join('; ') + moved)
  for (const p of problems) console.log(`- ${p}`)
  console.log(
    problems.length
      ? 'NOT COVERED: rerun or refresh the evidence above, or report it to the owner as not rerun.'
      : 'Evidence covers the current head and main.',
  )
  console.log(
    "This checks the evidence's freshness only; it doesn't establish the owner's approval or authorize a merge.",
  )
  return problems.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { review: { type: 'string' }, 'approved-at': { type: 'string' } },
  })
  if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]) || !values.review) {
    console.error(
      'usage: node scripts/merge-readiness.mjs <pr> --review <result file> [--approved-at <ISO time>]',
    )
    process.exit(2)
  }
  try {
    process.exit(
      report(positionals[0], { review: values.review, approvedAt: values['approved-at'] }),
    )
  } catch (e) {
    console.log(`UNKNOWN: ${e.message.replace(/\s+/g, ' ').trim()}`)
    console.log(
      "NOT COVERED. This checks the evidence's freshness only; it doesn't authorize a merge.",
    )
    process.exit(1)
  }
}
