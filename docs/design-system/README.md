# Design system

How the app's UI is built and why: the visual and interaction foundations, the components in `apps/app/src/components/ui/`, the patterns for whole tasks (saving, deleting, waiting, failing), and the page frames they sit in. It describes what exists in this repository; it doesn't add rules.

The structure follows [GitHub Primer](https://primer.style/product/) (read 2026-11-15): foundations, then components, then patterns, then whole pages, each linking the others, with accessibility guidance in every layer. Primer is the model for **how the documentation is organized**, not a source of rules: its components, branding and product decisions aren't adopted, and where its advice differs from ours (Primer avoids toasts; ours are for success only), our rule applies.

## Where the rules are

| Rule                                                                                                                                                                                                   | Source                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Components from `components/ui`, brand tokens only (no `gray-*`, hex or `style`), NativeSelect for simple choices, `AuthLayout`, error placement, success-only toasts, `destructiveSolid`, 24 px links | [`AGENTS.md`](../../AGENTS.md#ui-adr-0046) "UI"                                                                                      |
| Base UI under shadcn, tokens in `packages/brand`, contrast tests, CSP hashes, excluded components, no schemas in the browser                                                                           | [ADR-0046](../adr/0046-ui-foundation.md)                                                                                             |
| The Content Security Policy                                                                                                                                                                            | [ADR-0045](../adr/0045-app-security-headers.md)                                                                                      |
| Forms post and stay disabled until hydrated; nothing secret in client code                                                                                                                             | [`AGENTS.md`](../../AGENTS.md#invariants-non-negotiable) invariant 8                                                                 |
| The UI hides, the server decides                                                                                                                                                                       | invariant 4                                                                                                                          |
| How to build a page and prove it (visual, keyboard, e2e)                                                                                                                                               | the `ui-page` skill ([`.agents/skills/ui-page/SKILL.md`](../../.agents/skills/ui-page/SKILL.md)), [`docs/testing.md`](../testing.md) |

Every page here marks what kind each statement is when it matters: **Rule** (with its source), **Current** (what the code does, with its file), **Proposal** (needs a decision before anyone relies on it), **Gap** (an observed mismatch, not yet fixed) and **Not verified**.

## Contents

1. [Principles](principles.md): the reasons behind the rules.
2. Foundations: [color and themes](foundations/color.md), [typography](foundations/typography.md), [layout and spacing](foundations/layout.md), [iconography](foundations/iconography.md), [motion](foundations/motion.md), [accessibility](foundations/accessibility.md), [content](foundations/content.md).
3. [Components](components/README.md): the inventory and when to use each, grouped into [buttons](components/buttons.md), [forms](components/forms.md), [selection](components/selection.md), [dialogs](components/dialogs.md), [navigation](components/navigation.md), [feedback](components/feedback.md) and [data display](components/data-display.md).
4. [Patterns](patterns/README.md): whole tasks, including failure and interruption: [destructive actions](patterns/destructive-actions.md), [saving and submitting](patterns/saving-and-submitting.md), [errors and recovery](patterns/errors-and-recovery.md), [loading and empty states](patterns/loading-and-empty-states.md), [invitations and access](patterns/invitations-and-access.md), [billing handoffs](patterns/billing-handoffs.md).
5. [Page patterns](page-patterns/README.md): [authentication](page-patterns/authentication.md), [onboarding](page-patterns/onboarding.md), [collection and detail](page-patterns/collection-and-detail.md), [settings](page-patterns/settings.md).

6. [Modern Web Guidance](modern-web-guidance.md): looking up a web-platform technique (Google's guidance, external evidence) and checking it against our browser floor, CSP and components.

Starting a page? Read the page pattern for its kind, then the patterns its actions need, then the components. Building one: the `ui-page` skill.

## Surfaces

The design system covers the **app** (`apps/app`). The marketing site (`apps/site`, ADR-0033) shares only the colour tokens (`@saas-foundation/brand`); it ships no React and no scripts, so the components and patterns here don't apply to it. The docs site (`apps/docs`, ADR-0028) uses Starlight's own theme and doesn't use the tokens yet.

## Products

A product replaces the token values in `packages/brand/brand.css` with its brand (contrast tests keep checking them) and records its own UI rules in `docs/product/AGENTS.md` ([ADR-0041](../adr/0041-product-owned-documentation-and-agent-instructions.md), ADR-0046 decision 9). Its rules add to `AGENTS.md` "UI" and never weaken the CSP or the invariants. Product-specific patterns go in `docs/product/`, not in these pages, so upstream merges don't conflict.

## Deferred

From ADR-0046 "Deferred", each with its trigger there: a shared `packages/ui`, a theme toggle, the six excluded Base UI components, visual tests in CI. Not planned: a component playground or Storybook (ADR-0047 "Alternatives").
