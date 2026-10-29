# ADR-0008: AGENTS.md and ADRs are the canonical agent context

Status: Accepted · Date: 2026-09-27

## Decision

- Root `AGENTS.md` is the single rulebook: module map, invariants, commands, recipes, and a `## Code Review Rules` section used by Codex GitHub review. Keep it well under Codex's 32 KiB limit.
- `CLAUDE.md` contains `@AGENTS.md` plus implementer-only notes. Claude Code ignores `AGENTS.md` when a `CLAUDE.md` exists unless it's imported.
- Architecture changes update the ADRs and `AGENTS.md` in the same PR.
- Invariants map to executable checks where possible (lint rules, tests, CI checks).

## Notes

- **Size budget (2026-10-29, research R10):** Codex loads `AGENTS.md` files only up to `project_doc_max_bytes` (32 KiB by default, all files combined) and silently drops the rest. A local probe on Codex 0.165.0 lost a marker in the last section of a 48.9 KB file, with no warning. The Code Review Rules come last. `scripts/check-agents-size.mjs` (run by `pnpm lint` through its test) fails above 28,000 bytes, leaving room for a user's global file. Over it, prune by moving detail into the ADR or runbook it condenses, with a pointer.
