# ADR-0047: Developer handbook: a task-based index over the repository's Markdown

Status: Proposed · Date: 2026-11-15

## Context

The repository's developer documentation is rules (`AGENTS.md`), decisions (46 ADRs), runbooks, a testing guide, a glossary, an architecture overview, research archives and code comments. Each has an owner and a purpose, but nothing routes a question ("how do I build a page?", "why is this a 404?") to the document that answers it; a reader starts from the ADR list or a search. The UI has accepted rules (ADR-0046, `AGENTS.md` "UI") and a page procedure (`ui-page`), but no reference for choosing a component or handling a whole scenario (saving, deleting, an unknown outcome).

[ADR-0028](0028-public-docs-site.md) decision 8 keeps internal developer docs as Markdown in the repository, with no rendered internal site; its "Internal docs" note names the trigger for one. [ADR-0041](0041-product-owned-documentation-and-agent-instructions.md) gives products `docs/product/`, which the foundation never writes. [ADR-0008](0008-agents-md-canonical.md) keeps `AGENTS.md` the only rulebook, within a size budget; [ADR-0042](0042-tracked-agent-workflows.md) makes skills procedures that cite rules.

## Decision

1. **Entry point:** `docs/README.md` is the handbook index. It lists the rules in their precedence, routes common tasks to their document, names each kind of document and its authority, and separates foundation-owned from product-owned documents. The root `README.md` and `AGENTS.md` each link it in one line.
2. **Layout:** new handbook pages go in these directories, next to the existing ones, which don't move:

   | Directory               | Holds                                                                                  |
   | ----------------------- | -------------------------------------------------------------------------------------- |
   | `docs/guides/`          | tutorials and task guides (`first-change.md`)                                          |
   | `docs/architecture/`    | architecture reference (existing), recipes (existing), the domain model                |
   | `docs/integrations/`    | one reference page per external service the app depends on                             |
   | `docs/troubleshooting/` | symptom-based diagnosis, linking the runbooks and testing guide for procedures         |
   | `docs/design-system/`   | UI reference: principles, foundations, components, scenario patterns and page patterns |

   `docs/adr/`, `docs/runbooks/`, `docs/research/`, `docs/testing.md`, `docs/glossary.md` and `docs/roadmap.md` keep their paths and roles.

3. **Handbook pages explain; they don't rule.** A page links the rule, ADR or code behind each claim instead of restating it differently, and says which kind a statement is where it matters: a rule (with its source), current behaviour (with its file), a proposal (needs a decision), a known gap or not verified. A rule change goes to `AGENTS.md`, an ADR or `policy.ts` first; the page follows. When a page and a rule disagree, the rule wins and the page is corrected.
4. **Research stays evidence.** Pages may cite `docs/research/` and external guidance (the design system takes GitHub Primer's documentation structure as its model), labelled as such. Neither becomes a requirement until an ADR, `AGENTS.md` or the owner adopts it. No Primer package, branding or product policy is adopted.
5. **Agents discover it on demand.** `AGENTS.md` names the index once; skills link the pages relevant to their procedure (the `ui-page` skill links the design system). Nothing in the handbook is loaded automatically, so it doesn't count against `AGENTS.md`'s budget.
6. **Products:** the foundation's handbook pages ship to products like the rest of `docs/`. A product records its own additions (concepts, workflows, brand rules) in `docs/product/` and its own ADRs, not by editing these pages (ADR-0041).

## Alternatives

- **One large `docs/handbook.md`:** one file to find, but it would mix tutorials with reference, grow past readable size and duplicate the existing documents it summarises.
- **Expand `AGENTS.md`:** loaded by every agent session, but over its size budget (ADR-0008) and turns explanation into rules.
- **A rendered site (Starlight) now:** search and navigation, but every reader has repository access today, and ADR-0028 decision 8 settled this; an access-gated site adds a product and needs its own ADR.
- **A Primer-style design system as code (a component playground):** shows live components, but adds a deployable and CSP surface for a template whose components are already the code in `components/ui/`.

## Consequences

- Readers start from one page; existing documents keep their paths, so existing links keep working.
- Handbook pages cite code paths and can drift as the code changes. Mitigations: pages link files rather than copying numbers or signatures, and a PR that changes documented behaviour updates the page (the reviewer checks it like any doc). No link checker runs in CI; that waits for recurring broken links.
- A product inherits pages that describe the foundation's sample resources (projects) and policy; they say so where it matters.

## When to revisit

- Someone needs the handbook without repository access: ADR-0028's "Internal docs" note (an access-gated site, its own ADR).
- Broken links or stale examples recur: a link and anchor check in CI.
- A page grows into rules agents must always follow: move the rule to `AGENTS.md` or an ADR, keep the explanation here.
