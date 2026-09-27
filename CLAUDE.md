@AGENTS.md

## Claude Code (implementer)

- You implement; Codex reviews independently in a separate tree. Never self-approve.
- Loop: implement → `pnpm check` + `pnpm test` → hand off for review → apply only the review findings (narrow corrections) → re-review.
- Don't widen a PR beyond its task; propose follow-ups instead.
