# Color and themes

**Source of record:** [`packages/brand/brand.css`](../../../packages/brand/brand.css) (values), [`apps/app/src/styles.css`](../../../apps/app/src/styles.css) (Tailwind mapping), [`scripts/brand-contrast.mjs`](../../../scripts/brand-contrast.mjs) (tested pairs). Rules: AGENTS.md "UI", [ADR-0046](../../adr/0046-ui-foundation.md) decisions 2–3. This page doesn't repeat the values; read them in the file.

## Tokens

Every colour is a semantic token, written once as `light-dark(<light>, <dark>)` in oklch. Pages use the Tailwind classes generated from them (`bg-<token>`, `text-<token>`, `border-<token>`, `ring-<token>`), never `gray-*`, hex values or a `style` attribute (Rule, AGENTS.md "UI").

| Token pair                           | Use (current)                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `background` / `foreground`          | the page and its body text                                                                          |
| `card` / `card-foreground`           | cards (`Card`, the auth frame on wider screens, settings sections)                                  |
| `popover` / `popover-foreground`     | menus, selects, tooltips, the native select's picker                                                |
| `primary` / `primary-foreground`     | the default button, links (`text-primary`), the active nav item's fill                              |
| `secondary` / `secondary-foreground` | the secondary button and badge                                                                      |
| `muted` / `muted-foreground`         | quiet surfaces and secondary text (descriptions, "No projects yet.")                                |
| `accent` / `accent-foreground`       | a highlighted or hovered item in a menu or list                                                     |
| `destructive`                        | error text, invalid field borders, destructive buttons (tinted with `/10`; solid in a confirmation) |
| `border`, `input`, `ring`            | dividers and card edges; input and select borders; the focus indicator                              |
| `sidebar-*`                          | the tenant navigation bar and its active, hovered and focused items                                 |
| `--radius`                           | the corner radius scale (`rounded-sm` … `rounded-4xl`, derived in `styles.css`)                     |

A new pairing (a new variant, a new surface) is added to `scripts/brand-contrast.mjs` in the same change (the `ui-page` skill).

## Themes

The app follows the visitor's **system theme**. `color-scheme: light dark` in `styles.css` picks each token's side; Tailwind's `dark:` variant is `prefers-color-scheme`. There's no class, no script and no stored preference, so the CSP needs nothing (Current, ADR-0046 decision 2). A theme toggle is deferred until a product asks for one (ADR-0046 "Deferred").

Consequences for a page:

- A colour that isn't a token breaks in one of the themes. The visual tests take every page in both.
- Some components have explicit `dark:` adjustments, such as the outline button on `input/30` (in `button.tsx`); copy that approach only from an existing component and add the pair to the contrast list.
- Browser floor: the `light-dark()` function sets it (ADR-0046 decision 2). Below it, token colours are invalid and fall back to browser defaults (Not verified in such a browser).

## Contrast

`scripts/brand-contrast.test.mjs`, part of `pnpm lint`, checks every listed pair in both themes, translucent colours composited over their background: 4.5:1 for text (WCAG 1.4.3) and 3:1 for input borders, focus indicators and control fills (1.4.11). `node scripts/brand-contrast.mjs` prints each ratio (Current, [`docs/testing.md`](../../testing.md)).

What it doesn't check: pairs nobody added to the list, text on images, and anything a page builds from a non-token colour.

## Color is never the only signal

Errors are red **and** worded ("That doesn't match the organization's name") and announced (`FieldError` is `role="alert"`); invalid fields also get `aria-invalid`. The active nav item is filled **and** carries `aria-current` from the router. The danger zone in settings has a heading, not only a red border. Follow the same rule for any new status: words first, colour as reinforcement (Current; WCAG 1.4.1).

## For products

Replace the values in `brand.css` only; keep the token names, because the components use them. The contrast test then checks the new brand. Brand rules beyond values go in `docs/product/AGENTS.md`.
