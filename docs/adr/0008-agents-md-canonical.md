# ADR-0008: AGENTS.md and ADRs are the canonical agent context

Status: Accepted · Date: 2026-09-27

## Decision

- Root `AGENTS.md` is the single rulebook: module map, invariants, commands, recipes, and a `## Code Review Rules` section used by Codex GitHub review. Keep it well under Codex's 32 KiB limit.
- `CLAUDE.md` contains `@AGENTS.md` plus implementer-only notes. Claude Code ignores `AGENTS.md` when a `CLAUDE.md` exists unless it's imported.
- Architecture changes update the ADRs and `AGENTS.md` in the same PR.
- Invariants map to executable checks where possible (lint rules, tests, CI checks).

## Notes

- **Size budget (2026-10-29, research R10):** Codex loads `AGENTS.md` files only up to `project_doc_max_bytes` (32 KiB by default, all files combined) and silently drops the rest. A local probe on Codex 0.165.0 lost a marker in the last section of a 48.9 KB file, with no warning. The Code Review Rules come last. `scripts/check-agents-size.mjs` (run by `pnpm lint` through its test) fails above 28,000 bytes, leaving room for a user's global file. Over it, prune by moving detail into the ADR or runbook it condenses, with a pointer.
- **Recipes moved (2026-11-11):** at 27,999 of 28,000 bytes, `AGENTS.md`'s Recipes section moved word for word to `docs/architecture/recipes.md`. `AGENTS.md` keeps a `## Recipes` pointer that names each recipe, and a Code Review Rules bullet with the three requirements found only in the recipes (a child table's composite FK, the organization row lock for a count-then-insert, a check-then-write that holds in the write), so Codex's GitHub review still sees them. Size after the move: 25,608 bytes.
- **Trial recipes (2026-11-16):** two recipes were added for changes that had no local guidance: a guard script or CI workflow, and a runbook. They're recipes, not nested instruction files, because a recipe reaches both agents: `AGENTS.md` names it for the implementer, and the Code Review Rules bullet on skipped recipe steps covers the reviewer; Codex loads no instruction file outside the path from the root to its working directory, and Claude Code skips a nested `AGENTS.md` while a `CLAUDE.md` is above it. Whether they change anything is unproven. Checkpoint: after ten merged PRs that change `scripts/**`, `.github/**` or `docs/runbooks/**`, the owner reads those PRs' review findings next to ten earlier ones and keeps, rewords or removes the recipes.
