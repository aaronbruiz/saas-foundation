# Developer handbook

Start here to find the document that answers your question. The handbook explains and links the rules; it doesn't make them. How it's organized: [ADR-0047](adr/0047-developer-handbook.md).

## Where the rules are

Rules, in the order they win on a conflict ([`AGENTS.md`](../AGENTS.md) "Working rules"):

1. [`AGENTS.md`](../AGENTS.md): invariants, module map, UI rules, Code Review Rules. The only rulebook ([ADR-0008](adr/0008-agents-md-canonical.md)).
2. Accepted [ADRs](adr/README.md): each decision, its reasons and its limits. Some are accepted only in part (ADR-0040) or only for the current environment (ADR-0043, ADR-0044); the ADR's status line says which.
3. [`billing/policy.ts`](../apps/app/src/modules/billing/policy.ts): the product's plans, limits and lifecycle (ADR-0020).
4. The pull request's description: the spec for that change, until it merges ([ADR-0030](adr/0030-git-workflow.md)).

[`docs/roadmap.md`](roadmap.md) sets the current scope, freezes and what needs the owner's approval.

Everything else in `docs/` explains, shows how, or records evidence. When a handbook page and a rule disagree, the rule wins and the page is wrong: fix the page.

## Find a document by task

| I want to…                                   | Start with                                                                                                                                     | Then                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run the app locally                          | [`README.md`](../README.md) "Getting started"                                                                                                  | [First successful change](guides/first-change.md) steps 1–3; [Troubleshooting](troubleshooting/README.md#local-setup-fails-or-port-3000-is-in-use)            |
| Make my first change and open a PR           | [First successful change](guides/first-change.md)                                                                                              | [`.github/pull_request_template.md`](../.github/pull_request_template.md), ADR-0030                                                                           |
| Add a tenant-owned feature                   | [`start-new-product.md`](runbooks/start-new-product.md#6-build-the-first-feature) step 6 (the projects pattern)                                | [Recipes](architecture/recipes.md), [Domain model](architecture/domain-model.md)                                                                              |
| Build or change a page                       | [`AGENTS.md`](../AGENTS.md#ui-adr-0046) "UI" and the `ui-page` skill ([`.agents/skills/ui-page/SKILL.md`](../.agents/skills/ui-page/SKILL.md)) | [Design system](design-system/README.md): foundations, components, patterns, page patterns                                                                    |
| Change the database schema                   | [Recipes](architecture/recipes.md) "Add a tenant-owned table"; AGENTS.md invariant 10                                                          | [Testing: database checks](testing.md#database-checks), [Database integration](integrations/database.md)                                                      |
| Test tenant isolation                        | [Testing: tenant isolation](testing.md#tenant-isolation)                                                                                       | [Domain model: access](architecture/domain-model.md#how-a-request-is-authorized)                                                                              |
| Diagnose a failed request or test            | [Troubleshooting](troubleshooting/README.md)                                                                                                   | [Testing: troubleshooting](testing.md#troubleshooting), [Runbooks](runbooks/README.md)                                                                        |
| Work with billing, email, auth or Hyperdrive | [Integrations](integrations/README.md)                                                                                                         | The matching runbook section                                                                                                                                  |
| Release or roll back                         | [Runbook "Releases"](runbooks/README.md#releases-adr-0029)                                                                                     | [Runbook "Rollback"](runbooks/README.md#rollback-adr-0029), [ADR-0029](adr/0029-releases-deploys-and-rollback.md)                                             |
| Start a product from this foundation         | [`start-new-product.md`](runbooks/start-new-product.md)                                                                                        | [ADR-0041](adr/0041-product-owned-documentation-and-agent-instructions.md) (product docs), [ADR-0027](adr/0027-polyglot-service-and-repository-boundaries.md) |
| Understand why something is the way it is    | [ADR index](adr/README.md)                                                                                                                     | [Architecture](architecture/README.md) (each part's decision), [Glossary](glossary.md)                                                                        |
| Look up a term                               | [Glossary](glossary.md)                                                                                                                        | [Domain model](architecture/domain-model.md) (how the terms relate)                                                                                           |

Agents: `AGENTS.md` is loaded automatically and this index is not. Read it when a task needs more than the rules: it names the page to open, so you don't have to search.

## Kinds of document

| Kind            | What it's for                                                                 | Where                                                                                                                                                                                       | Authority                                                                         |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Tutorial        | Learn by doing one thing end to end                                           | [`guides/`](guides/first-change.md)                                                                                                                                                         | Explains; links the rules it follows                                              |
| Recipe, runbook | Required steps for a known change or operation                                | [`architecture/recipes.md`](architecture/recipes.md), [`runbooks/`](runbooks/README.md)                                                                                                     | Procedures; recipes are part of the rules (AGENTS.md "Recipes")                   |
| Reference       | Look something up: architecture, domain, integrations, testing, design system | [`architecture/`](architecture/README.md), [`integrations/`](integrations/README.md), [`testing.md`](testing.md), [`glossary.md`](glossary.md), [`design-system/`](design-system/README.md) | Describes current behaviour, linking the rule or code behind each claim           |
| Troubleshooting | Start from a symptom                                                          | [`troubleshooting/`](troubleshooting/README.md)                                                                                                                                             | Diagnosis aid; causes are hypotheses until evidence confirms them                 |
| Decision (ADR)  | Why a choice was made, its alternatives and when to revisit it                | [`adr/`](adr/README.md)                                                                                                                                                                     | Binding once accepted                                                             |
| Research        | Evidence gathered for a decision not yet made                                 | [`research/`](research/)                                                                                                                                                                    | None: not policy until an ADR, `AGENTS.md` or the owner adopts it                 |
| Agent skill     | A repeatable procedure an agent runs (`/review-pr`, `/ui-page`, …)            | [`.agents/skills/`](../.agents/skills/)                                                                                                                                                     | Procedure only; cites the rules ([ADR-0042](adr/0042-tracked-agent-workflows.md)) |

Reference pages say which kind each statement is when it matters: a **rule** (with its source), **current behaviour** (with the file), a **proposal** (needs a decision), a **known gap** (observed, not yet fixed) or **not verified**.

## Foundation and product documents

This repository is the foundation. A product cloned from it keeps all of the above and adds its own documents in `docs/product/`, which the foundation never ships or edits ([ADR-0041](adr/0041-product-owned-documentation-and-agent-instructions.md)): its overview, glossary, architecture additions, roadmap and agent rules (`docs/product/AGENTS.md`, loaded by the line at the top of `AGENTS.md`). Outlines and when to write each: [`start-new-product.md`](runbooks/start-new-product.md#7-document-the-product) step 7.

In a product repository, read `docs/product/roadmap.md` instead of `docs/roadmap.md`, and `docs/product/glossary.md` next to this glossary. The foundation's handbook pages stay as they are; a product documents its own differences in `docs/product/` and its own ADRs rather than editing them, so `git merge upstream/main` keeps working.

## Public documentation

The customer-facing docs site (`apps/docs`, ADR-0028) is separate: it's public, built from `apps/docs/src/content/docs/`, and holds nothing from this handbook. This handbook stays in the repository as Markdown, read on GitHub or in a checkout, with no rendered internal site ([ADR-0028](adr/0028-public-docs-site.md) decision 8). When someone needs it without repository access, ADR-0028's "Internal docs" note says what to revisit.
