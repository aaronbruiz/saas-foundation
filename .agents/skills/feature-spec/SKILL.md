---
name: feature-spec
description: Turn a feature request, or a change to one in progress, into a PR description (Goal, Behaviour, Out of scope, Checks) before code. Use for policy-heavy or multi-step features; a small change only needs the PR template.
---

# Plan a feature as a PR description

Trial skill (ADR-0042 Notes). The output is PR description text (ADR-0030); write no spec file.

1. **Questions:** authorization, tenancy, billing or tenant-data decisions that `AGENTS.md`, `docs/product/AGENTS.md`, the ADRs and `billing/policy.ts` don't settle. Rank by safety and rework risk; give two or three options each, with what each changes. The dependent behaviour is blocked (AGENTS.md "Working rules"); everything else continues.
2. **Behaviour:** one line per case the PR template lists. Expected outcomes come from the request, an accepted rule or the policy; check each against the existing contracts and tests (file:line). Where they disagree, follow them or ask. An outcome nothing settles in those four areas is a question.
3. **Races:** for each check followed by a write, including a write a library makes, say where the condition holds (AGENTS.md recipe "Add a tenant-scoped server function"). The concurrency line names the interleaving.
4. **Checks:** per Behaviour line, the planned test (the file to copy) or manual check, with empty result and commit columns.

**Amending:** when scope changes mid-work, update Behaviour and Out of scope first, list the tests and code the change affects, and stop only the work that depends on an unsettled change. After the owner approves Behaviour, amendments follow AGENTS.md "Working rules".

Output: the PR description draft, plus "Blocked on owner".
