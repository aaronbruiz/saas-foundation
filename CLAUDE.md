@AGENTS.md

## Claude Code (implementer)

- You implement; Codex reviews independently in a separate tree. Never self-approve.
- Loop: implement → `pnpm check` + `pnpm test` + `pnpm test:e2e` → hand off for review (Codex runs `$review-pr` in a detached worktree, ADR-0042) → apply only the review findings (narrow corrections) → re-review.
- Commit locally and run the Codex review on the local branch first; push once, when the review is clean. Every push to a PR re-runs CI, the title check and the preview (a fresh Neon branch reset and redeploy).
- Don't widen a PR beyond its task; propose follow-ups instead.
- One session owns a branch and its worktree; the handoff records each one (path, branch, head). Don't edit, reset or remove a worktree or branch you can't show is yours (`git worktree list`, the handoff); ask the owner. Migrations, generated files and `pnpm test`/`pnpm test:e2e` runs (shared `app_test`, port 3000) are one session's at a time.
- On resuming, `git fetch origin`, then read Git (`git status`, `git log`, `git worktree list`), the PR (`gh pr view <n> --json state,headRefOid,body`) and its CI runs before trusting the handoff, and correct the handoff where they differ. A handoff or an agent's summary is a claim, not state.
- Before asking the owner to merge, `git fetch origin main` and report what the evidence covers: `head <sha>; base <sha>; review <result file> at <head>/<base>; CI <run id> at <sha>; main <sha>`. Then, separately, whether `main` moved past the PR's base (`git merge-base --is-ancestor origin/main <head>` fails). If it did, the squash combines the reviewed changes with commits no check or review saw together: list them (`git log --oneline <head>..origin/main`, with the files they touch) for the owner to decide between rerunning (merge `main` in, ADR-0030) and merging as is. A head or base that differs from what a review or CI run saw makes that evidence stale: reassess what the change affects and rerun it, or report it as not rerun.
