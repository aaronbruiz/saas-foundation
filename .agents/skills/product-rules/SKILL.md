---
name: product-rules
description: Draft or update a product's docs/product/AGENTS.md (ADR-0041) from owner decisions: module map rows, product rules and review checks, each showing its source, enforcement and verification. Use when a product is being defined, or when it gains rules agents must follow.
---

# Draft product rules

Trial skill (ADR-0042 Notes). It proposes; the owner's approval makes a rule active.

1. Read `docs/product/AGENTS.md` if it exists, root `AGENTS.md` (never restate or weaken it), `docs/product/overview.md`, `glossary.md`, `architecture.md`, the product ADRs, `apps/app/src/server/permissions.ts` and `apps/app/src/modules/billing/policy.ts`.
2. Collect candidate rules: what the product's workflows rely on and the foundation doesn't state (who may do what, state transitions, one-of constraints, retention). Keep apart what the owner decided, what the code does today, and what is unanswered. Code alone doesn't approve a policy.
3. For each candidate write: the rule in one sentence; its decision source (owner decision or product ADR) and reason; its runtime enforcement (capability, constraint, repository check), or "absent"; its verification (test or review check) with its status, planned or verified. A test or review check doesn't show that a runtime constraint exists.
4. Unsettled authorization, tenancy, billing or tenant-data policy stays a question for the owner (AGENTS.md "Working rules"). Rank questions by safety and rework risk, with two or three options and the work that depends on each. Don't invent limits, roles, retention periods or service levels.
5. Exceptions follow the rule's own approval path: the ADR it came from, or the owner's decision recorded in the PR. Nothing here waives a root invariant or grants a tool permission.
6. Offer these as candidate review checks where they apply: new dependencies (who reviewed them, why they're needed), and each new trust boundary's abuse cases.
7. Output a proposed diff for `docs/product/AGENTS.md` with "Module map" rows, "Product rules" and "Product review checks", plus "Decisions for the owner". Keep it short: every session loads it. Write the file only when asked.
