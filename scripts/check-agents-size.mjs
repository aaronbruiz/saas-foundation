#!/usr/bin/env node
// Fails when AGENTS.md exceeds its size budget. Codex loads AGENTS.md files only up to
// `project_doc_max_bytes` (32 KiB by default, all files combined) and silently drops the rest,
// and the Code Review Rules are at the end (research R10, 2026-10-29; ADR-0008 note). The budget
// leaves room for a user's global ~/.codex/AGENTS.md. Over it: prune by moving detail into the
// ADR or runbook it condenses, with a pointer.
// Usage: node scripts/check-agents-size.mjs [file]
import { statSync } from 'node:fs'

const BUDGET = 28_000
const file = process.argv[2] ?? new URL('../AGENTS.md', import.meta.url).pathname
const { size } = statSync(file)
if (size > BUDGET) {
  console.error(
    `${file} is ${size.toLocaleString('en-US')} bytes, over its ${BUDGET.toLocaleString('en-US')}-byte budget ` +
      '(Codex drops instructions past 32 KiB): move detail into the ADR or runbook it condenses.',
  )
  process.exit(1)
}
