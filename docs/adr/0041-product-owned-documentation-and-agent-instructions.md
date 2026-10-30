# ADR-0041: Product-owned documentation and agent instructions

Status: Accepted (owner 2026-10-30) · Date: 2026-10-30

## Context

A product starts as a clone of this foundation and keeps it as `upstream`, merging its fixes later ([`start-new-product.md`](../runbooks/start-new-product.md) step 1). The product needs its own documentation (what it is, its terms, its added services) and its own rules for agents (its modules, its review checks). If it writes them into foundation-owned files (`AGENTS.md`, `docs/architecture/README.md`), every upstream change to those files conflicts with the product's edits.

[ADR-0008](0008-agents-md-canonical.md) makes the root `AGENTS.md` the single rulebook, imported by `CLAUDE.md`. [ADR-0027](0027-polyglot-service-and-repository-boundaries.md) sets what `apps/` and `packages/` directories mean (deployables and libraries). Neither says where product documentation or product agent instructions go.

How agents load a second instructions file was tested on 2026-10-30 in throwaway repositories set up like this one (`CLAUDE.md` = `@AGENTS.md`, the root line below in `AGENTS.md`), once without and once with a `docs/product/AGENTS.md` holding a product rule:

- **Claude Code** (`claude -p`, file tools disabled): without the file it reported no product rule and no error; with it, it applied the rule and flagged a violation in a review-style prompt. Mechanism: recursive `@` imports, `CLAUDE.md` → `@AGENTS.md` → `@docs/product/AGENTS.md` (documented; a missing import is tolerated, observed).
- **Codex** (`codex exec -s read-only`): without the file it reported no product rule; with it, it read both files, applied the rule and flagged the violation. Mechanism: it follows the root file's instruction. Codex loads `AGENTS.md` files automatically only from the repository root down to the working directory, so `docs/product/AGENTS.md` isn't auto-loaded.

## Decision

1. **Product-owned documentation lives in `docs/product/`.** The foundation ships no file there and never edits it. The runbook's "Document the product" step gives outlines for `overview.md`, `glossary.md`, `architecture.md` and `AGENTS.md` and says when each is written.
2. **Product agent instructions live in `docs/product/AGENTS.md`**, loaded by one permanent line right after the root `AGENTS.md`'s opening paragraph:

   > Product instructions: if `docs/product/AGENTS.md` exists, read it before planning or changing anything; its rules add to these and never override the invariants below. @docs/product/AGENTS.md

   The line stays plain text (an `@` path inside a code span isn't imported). The root file has no product-editable section: a product edits only its own file, and the root line keeps working in the foundation, where the file doesn't exist.

3. **The foundation provides** the rules every product keeps (root `AGENTS.md`), the architecture overview of the foundation itself (`docs/architecture/README.md`, naming deployments by role and linking the configuration that holds each name, so a product doesn't have to rewrite it), the foundation glossary and testing guide (`docs/glossary.md`, `docs/testing.md`, added by a follow-up PR), the ADRs, the runbooks and the adoption outlines. **A product writes** its overview, glossary, architecture additions and agent rules in `docs/product/`, and its decisions as new ADRs in its own repository (`start-new-product.md` step 8).
4. **Precedence:** product rules add to the root rules. They never override the invariants; changing a foundation rule takes a product ADR that supersedes the one behind it, and the change goes in the product's `AGENTS.md` like any other ADR-driven change (ADR-0008).

This amends nothing in ADR-0008: the root `AGENTS.md` stays the canonical rulebook, and the product file adds to it. It introduces the product-owned directory convention itself and is compatible with ADR-0027's directory semantics: `docs/product/` holds documentation, not a deployable or a library.

## Consequences

- Upstream merges don't touch product documentation. This **reduces** conflicts, it doesn't remove them: product edits to foundation-owned files (code, `wrangler.jsonc`, workflows, `policy.ts`, `README.md`) can still conflict.
- Claude Code loads the product file automatically through the import. Codex loads it because the root line tells it to: that depends on the model following the instruction (observed in both prompt types tested, not guaranteed). Codex's GitHub-side review wasn't tested.
- Claude subagents that start without project instructions get neither file; their prompts have to carry the rules they need.
- The product file isn't counted in Codex's `project_doc_max_bytes` budget (it's read by a tool, not auto-loaded), but it still costs context in every session: keep it short and specific.
- The root line costs about 200 bytes of the root file's size budget (ADR-0008 Notes).

## Notes (2026-10-30)

Owner-approved amendment: `docs/product/roadmap.md` is a product-owned file too. In a product repo it replaces `docs/roadmap.md` as the file that sets scope, engineering rules and approvals, through a clause on the root `AGENTS.md` line that names the roadmap. Otherwise a clone would follow the foundation's milestones and freezes. Outline: `docs/runbooks/start-new-product.md` step 7.
