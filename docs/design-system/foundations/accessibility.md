# Accessibility

What is checked automatically, what is checked by procedure, and what hasn't been checked at all. Nothing here claims conformance to a WCAG level.

## What each check proves

| Check                          | Proves                                                                                                                                                                             | Runs                            | Source                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Brand contrast test            | every listed token pair meets 4.5:1 (text) or 3:1 (borders, focus, fills) in both themes                                                                                           | `pnpm lint`, CI                 | `scripts/brand-contrast.test.mjs`                                          |
| E2E selectors by role and name | the elements tests use have the role and accessible name they're found by                                                                                                          | `pnpm test:e2e`, CI             | `apps/app/e2e/`, the `ui-page` skill                                       |
| Visual tests                   | pages render in Chromium, Firefox and WebKit at 320 and 1280 px in both themes, without CSP refusals                                                                               | local only (`pnpm test:visual`) | ADR-0046 decision 8, [`docs/testing.md`](../../testing.md)                 |
| Keyboard pass                  | on the settings page: Tab order, a visible focus indicator at every stop, the picker's arrow keys and Escape, the toast not taking focus, the dialog's focus trap and focus return | local only                      | [`visual/keyboard.visual.ts`](../../../apps/app/visual/keyboard.visual.ts) |
| Base UI primitives             | the dialog, alert dialog, menu, select, tabs, popover and tooltip implement their ARIA patterns (upstream's claim)                                                                 | none locally beyond the above   | Base UI 1.9.0                                                              |

## Not verified

- **No assistive-technology testing** (screen readers, voice control, magnifiers) has been done on any page.
- **No automated accessibility scan** (axe or similar) runs; the runbook's pre-pilot list asks for at least a keyboard check of sign-up, sign-in, invitations and settings ([runbook](../../runbooks/README.md#before-admitting-pilot-users-open-checks)).
- The keyboard pass covers the settings page only; other pages' keyboard behaviour is assumed from the components.
- Announcements of status and errors (`role="status"`, `role="alert"`) haven't been heard in a screen reader.

A primitive's accessible markup isn't evidence that a task is accessible: focus after an item is removed, what's announced after a save, and whether an error is reachable belong to the page ([patterns](../patterns/README.md)).

## Expectations that are rules

- Every focus stop shows an indicator; the components draw it with the `ring` token (the `ui-page` skill's keyboard check).
- Links on their own line or in a menu are at least 24 px tall (AGENTS.md "UI", WCAG 2.5.8).
- Invalid input marks its field (`data-invalid`, `aria-invalid`) and shows a `FieldError`; other failures use a form-level `role="alert"` (AGENTS.md "UI").
- Color is never the only signal ([color](color.md#color-is-never-the-only-signal)).

## CSP and what it rules out

The CSP refuses inline styles except four hashes (ADR-0045 decision 5). So:

- Pages never set `style`, and a library that injects styles can't be added without a CSP change.
- Base UI's slider, progress, meter, scroll-area, accordion and collapsible render value-dependent inline styles and are excluded by lint (ADR-0046 decision 5). For a disclosure, the organization menu uses a native `<details>`; for progress, words ("Saving…").
- Base UI's own `<style>` elements are turned off (`CSPProvider disableStyleElements` in `__root.tsx`), and the one rule they carried lives in `styles.css`.
- E2E fails on any refusal; WebKit's native `<select>` refusal is the only exclusion, in visual tests only ([`docs/testing.md`](../../testing.md)).
