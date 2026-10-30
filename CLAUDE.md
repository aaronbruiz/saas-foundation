@AGENTS.md

## Claude Code (implementer)

- You implement; Codex reviews independently in a separate tree. Never self-approve.
- Loop: implement → `pnpm check` + `pnpm test` + `pnpm test:e2e` → hand off for review (Codex runs `$review-pr` in a detached worktree, ADR-0042) → apply only the review findings (narrow corrections) → re-review.
- Commit locally and run the Codex review on the local branch first; push once, when the review is clean. Every push to a PR re-runs CI, the title check and the preview (a fresh Neon branch reset and redeploy).
- Don't widen a PR beyond its task; propose follow-ups instead.
