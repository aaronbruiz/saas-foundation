# ADR-0046: UI foundation: shadcn on Base UI, brand tokens in `packages/brand`, under the strict CSP

Status: Accepted (owner decisions 2026-11-10 and 2026-11-11) · Date: 2026-11-11

Owner 2026-11-10: decisions 1–7 of the UI foundation brief; 2026-11-11: the "Stone and teal" preset, the two CSP hash directives (ADR-0045, as amended), NativeSelect for simple choices, and the WebKit `<select>` exclusion in visual tests. Research and experiment results: `.local/research/website-ui-research-2026-11-10.md`, `.local/ui-experiment-2026-11-10/` (git-ignored, kept by the owner).

## Context

Pages were hand-rolled Tailwind: one `lib/ui.tsx` with an input and a button class, `gray-*` colours, no tokens, no dark theme, no guidance. Products built from this template are mostly written by agents, and an agent asked to build a page in the experiment guessed spacing, colour, states and copy, and pulled zod into the browser.

The app's CSP (ADR-0045) has `style-src 'self'`: no inline style attribute or `<style>` element. Most component libraries render some. The experiment measured shadcn on Base UI in Chromium, Firefox and WebKit: exactly two things were refused, sonner's injected stylesheet and the `style` attribute on the hidden inputs Base UI's form controls render on the server. Six other Base UI components render value-dependent inline styles (a width, a position) that no hash can allow.

## Decision

1. **Base:** shadcn (style `base-vega`, `components.json`) on Base UI (`@base-ui/react`, pinned exactly), components copied into `apps/app/src/components/ui/`. They take data through props only: no `modules/`, `server/`, routes or contracts (lint). The app's pages move onto them one PR at a time; this PR moves the shell and organization settings.
2. **Tokens:** `packages/brand` (`@saas-foundation/brand`, the package ADR-0028 deferred), one CSS file, `brand.css`, with every colour as `light-dark(<light>, <dark>)` in oklch. `color-scheme` picks the side: the app is `light` and switches with the `.dark` class (nothing sets it until every page is on tokens); the marketing site uses `light dark`, so it follows the visitor's system with no script. A product replaces the values in that file. The preset is "Stone and teal" (warm grey neutrals, a deep teal primary, 0.75rem radius).
3. **Contrast is tested:** `scripts/brand-contrast.test.mjs` (in `pnpm lint`) checks every listed token pair in both themes, translucent colours composited over their background: 4.5:1 for text (WCAG 1.4.3), 3:1 for input borders, focus indicators and control fills (1.4.11). shadcn's own default tokens fail five of these pairs.
4. **CSP, no loosening of `style-src`:** two directives, each by exact hash, generated from the installed packages into `apps/app/src/server/csp-hashes.gen.ts` (`pnpm csp:hashes`; `pnpm check` fails when it drifts):
   - `style-src-elem 'self'` plus sonner's two hashes: it appends an empty `<style>`, then its CSS;
   - `style-src-attr 'unsafe-hashes'` plus Base UI's two hidden-input styles.
     Base UI's own `<style>` elements are turned off (`CSPProvider disableStyleElements`) and their one rule lives in `styles.css`. `sonner` and `@base-ui/react` are pinned exactly; sonner has its own Dependabot group.
5. **Excluded components:** Base UI's slider, progress, meter, scroll-area, accordion and collapsible, and the package root that re-exports them, fail lint.
6. **Selects:** a simple single choice in a form is shadcn's `NativeSelect`, a native `<select>` styled with the tokens and progressively enhanced with `appearance: base-select` where supported (Chromium 135+, Safari 27; Firefox keeps the OS list). Base UI `Select` is for rich options, grouping, search or custom interaction (shadcn's own split).
7. **No schemas in the browser:** routes and components import `@saas-foundation/contracts` types only; forms use HTML constraint attributes and the server's errors (PR #252).
8. **Evidence:** e2e fails on any CSP refusal (PR #252). Visual tests (`pnpm test:visual`, through `scripts/test-lock.sh visual`) run Chromium, Firefox and WebKit from the Docker image pinned to the installed Playwright version, at 320 and 1280 px, light and dark, against committed baselines; they run the same strict check with two WebKit-only exclusions (`docs/testing.md`). Not run in CI (Actions minutes).
9. **Guidance:** the rules live in `AGENTS.md` "UI"; a product's brand rules in its `docs/product/AGENTS.md`. A tracked UI skill (procedure) follows once the pilot and the page migrations show what agents need.

## Alternatives

- **Plain Tailwind, growing `lib/ui.tsx`:** no accessible primitives for dialogs, menus or popovers; every product would re-derive them.
- **shadcn on Radix or React Aria:** same CSP problem class (positioning and hidden inputs); Base UI is shadcn's default since 2026-07 and offers `CSPProvider`.
- **`style-src 'unsafe-inline'` or `style-src-attr 'unsafe-inline'`:** allows any injected style; refused by the owner.
- **A nonce for styles:** Base UI supports one, sonner doesn't, and the hidden-input attribute can't carry one.
- **Base UI Select for the transfer picker:** it would change `e2e/slice.spec.ts`, an isolation test that must stay unchanged; a native select fits a simple choice.

## Deferred

| Decision                                      | Options                                                     | Trigger                                   |
| --------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| Shared React components package `packages/ui` | move `components/ui` into a package                         | a second React consumer of the components |
| Dark mode in the app                          | system preference, then a toggle                            | every page on tokens                      |
| The excluded Base UI components               | a CSS-only equivalent, or a nonce/hash design per component | a page that needs one                     |
| Visual tests in CI                            | a scheduled job in the pinned image                         | Actions budget                            |

## Consequences

- A sonner, React or Base UI bump that changes an injected style fails `pnpm check` until the hash file is regenerated; the diff is a CSP change and is reviewed as one.
- Pages not yet migrated keep their `gray-*` classes; they look as before in light, and dark stays off.
- The marketing site depends on `packages/brand` (its CI path filter includes it); it still ships no scripts and no inline styles.
- WebKit (Playwright's build) refuses its own stylesheet for a native `<select>` under `style-src 'self'`; a canary test fails when that stops, so the exclusion can be removed.
