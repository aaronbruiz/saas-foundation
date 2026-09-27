# ADR-0008: AGENTS.md and ADRs are the canonical agent context

Status: Accepted · Date: 2026-09-27

## Decision

- Root `AGENTS.md` is the single rulebook: module map, invariants, commands, recipes, and a `## Code Review Rules` section used by Codex GitHub review. Keep it well under Codex's 32 KiB limit.
- `CLAUDE.md` contains `@AGENTS.md` plus implementer-only notes. Claude Code ignores `AGENTS.md` when a `CLAUDE.md` exists unless it's imported.
- Architecture changes update the ADRs and `AGENTS.md` in the same PR.
- Invariants map to executable checks where possible (lint rules, tests, CI checks).
