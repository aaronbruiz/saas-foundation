@AGENTS.md

## Claude Code (implementer)

- You implement; Codex reviews independently in a separate tree. Never self-approve.
- Loop: implement → `pnpm check` + `pnpm test` → hand off for review → apply only the review findings (narrow corrections) → re-review.
- Actions minutes are limited (private repo, GitHub Free). Commit locally and run the Codex review on the local branch first; push once, when the review is clean. Every push to a PR re-runs CI, the title check and the preview (about 12 billed minutes).
- Don't widen a PR beyond its task; propose follow-ups instead.
