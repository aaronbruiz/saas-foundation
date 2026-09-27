# ADR-0012: Claude Code implements, Codex reviews, in separate working trees

Status: Accepted · Date: 2026-09-27

## Decision

- Claude Code implements. Codex reviews independently. They never change the same working tree.
- Loop: implementation → tests → adversarial review → narrow corrections → re-review → human approves the merge.
- Codex review follows `AGENTS.md` → `## Code Review Rules` (behaviour and security). Formatting and lint are CI's job.

## Consequences

- An independent second model checks tenant isolation, authorization, billing boundaries and migration safety.
- Review rules must name concrete failure modes, so the review doesn't become a rubber stamp.
