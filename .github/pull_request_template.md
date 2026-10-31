<!-- Title: a Conventional Commit, e.g. `feat(billing): annual plans` (ADR-0030; CI checks it). It becomes the squash commit on `main`. -->

## Goal

<!-- First sentence: what changes for the user or caller, in plain language, no jargon. Then why, in a sentence or two. A bug fix names the cause; an approach that isn't the obvious one says why. -->

## Behaviour

<!-- What a user or caller observes after this PR, including the failure cases (404/403, limits, errors). Name the actor and preconditions; cover another tenant's resource, an insufficient role and concurrent requests where they apply. One line per case, e.g. "When a member invites, the server returns 403 and nothing changes." Open authorization, tenancy, billing or tenant-data questions: who decides; the behaviour that depends on them isn't built yet. Take each expected outcome from the request, an accepted rule or the policy; check it against the existing contracts and tests, and follow them or raise the conflict as a question. For a check followed by a write, say where the condition holds. After the owner approves, a line changes only by adding "Amended <date>: <what changed>; owner saw it in <where>." -->

## Out of scope

<!-- What this PR deliberately doesn't do; follow-ups. -->

## Checks

<!-- Spec: approved by the owner at <time>, or "approval not required" (AGENTS.md "Working rules"). Commands run and their results: pnpm check, pnpm test, pnpm test:e2e, manual checks. How each Behaviour item is verified (test or manual check), and what stays unverified and why. Name the head and base commits the results ran on (SHAs or CI run); if either changes before merge, rerun the results it affects or mark them stale. A check not run says "not run" and why; a waived check names who waived it. Review: the result and the head and base it saw. A test deleted, skipped, weakened or corrected: which and why. Visible UI: what was checked on the preview. Docs: ADR and AGENTS.md updated, or "no impact". Migrations: forward-safe (expand → migrate → contract, invariant 10); a contract migration has `!` in the title because rolling back past it isn't code-only, and the database is recovered only from a restore point by the runbook (ADR-0029). -->
