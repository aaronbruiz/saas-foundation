---
name: review-pr
description: Independent, read-only review of a saas-foundation pull request or local branch, or of the corrections made after an earlier review (ADR-0012). Use when asked to review a PR, a branch or its fixes. It reports findings with evidence; it never edits, approves or merges.
---

# Review a PR

## Boundaries

- Read-only. Don't edit, format, commit or push, and don't run commands that change files, a database or GitHub. Fixes are suggested in findings, never applied.
- Don't approve, request changes on or merge the PR (no `gh pr review`, no `gh pr merge`). The owner decides the merge.
- Don't review your own work: if this session wrote the change, stop and say so (ADR-0012).

## 1. Scope

Inputs from the invoker: the base (default `origin/main`), the PR number or its description, any extra risks; for a correction review, the previous result file and the list of corrections.

- Reviewed: `git diff <base>...HEAD`. Start the output with the base and head commits and the number of changed files. Given a PR number, compare HEAD with the PR's head (`gh pr view <n> --json headRefOid`) and say if they differ: the review covers only the head and base you read (AGENTS.md "Working rules").
- The spec: the PR description (`gh pr view <n> --json body -q .body` when given a number, otherwise the text the invoker passed). Without one, say so and review against the commit messages.
- Context to read: root `AGENTS.md`, `docs/product/AGENTS.md` if it exists, and each ADR that the changed paths fall under (AGENTS.md "Module map") or a Code Review Rules bullet names.
- Out of scope: code outside the diff except as context. List anything you couldn't check under "Not checked".

## 2. Passes

1. **Rules:** go through AGENTS.md "Code Review Rules" and check the bullets the diff touches. Cite the bullet or ADR; don't restate it.
2. **Abuse**, when the diff adds or changes a route, server function, repository function, migration, auth hook or webhook: for each new input, try another tenant's slug or resource id, a role without the capability, input outside its contract in `packages/contracts`, a replayed or out-of-order event, and concurrent requests: for each check followed by a write, including a write a library makes, whether the condition holds in the write (AGENTS.md recipe "Add a tenant-scoped server function"). The expected outcome comes from the cited invariant and the contract. Name the test that proves each case, or report it missing; a missing test isn't a proven vulnerability.
3. **Verification:** one row per Behaviour item in the PR description, failure cases included: the test (file:line), the manual check recorded under Checks, "unverified, listed" or "unverified, not listed". Judge the rows against the Code Review Rules bullet on Behaviour items.
4. **Checks:** compare the PR's Checks section with the diff and CI (AGENTS.md "Working rules" on reporting checks).
5. **Docs:** AGENTS.md "Done means" and, in a product repository, the `docs/product/` triggers in `docs/runbooks/start-new-product.md` step 7. Open the links in changed docs.

## 3. Evidence

- Every finding gives a location (file:line in the diff, or the rule's file:line) and its evidence: the code, a command with its output, or the quoted doc text.
- Keep checks you ran apart from checks you didn't: "verified: `<command>` → `<result>`" or "not run: `<check>` (why)". Never report a check you didn't run as passing.
- Read-only commands (`git`, `grep`, `gh pr view`, reading CI results) are fine. Don't run `pnpm test` or `pnpm test:e2e` unless the invoker asks; use the PR's Checks and CI instead.

## 4. Correction review

Given the previous result and the corrections: mark each earlier finding resolved or not resolved, with evidence; then check only whether the corrections introduced a new problem. Don't re-review untouched code. If a correction changed behaviour or the PR description changed, redo the verification rows it affects. How many rounds: `docs/roadmap.md` "Engineering rules".

## Output

```
Base <sha> → head <sha> (PR head: same | <sha>), <n> files
BLOCKER | SHOULD-FIX | NIT: <file:line>: <finding>. Rule: <bullet or ADR>. Failure: <scenario>. Evidence: <code, command output or quote>
Verification: | Behaviour item | evidence | status |
Checks by the reviewer: verified: … / not run: …
Not checked: … (why)
```

With no findings, write "No findings" under the same header, still with the verification table, the checks and "Not checked". No style comments.
