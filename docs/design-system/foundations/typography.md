# Typography

**Source:** [`apps/app/src/styles.css`](../../../apps/app/src/styles.css) (`--font-sans`, `--font-heading`), the routes. There's no type-scale token beyond Tailwind's defaults; what follows is the usage the pages share (Current), not a rule.

## Font

Inter Variable, self-hosted from `@fontsource-variable/inter` (so the CSP's `font-src 'self'` covers it), with `sans-serif` as the fallback. Headings use the same family (`--font-heading: var(--font-sans)`).

## Hierarchy in use

| Element                                | Classes in use                              | Where                                                                          |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Page title (`h1`), auth and full pages | `text-2xl font-semibold`                    | `AuthLayout`, `NotFound`, `ErrorPage`, account                                 |
| Tenant name (`h1`), in the shell       | `text-xl font-semibold`                     | `t.$tenant.tsx` (organization menu)                                            |
| Section of a tenant page (`h2`)        | `text-lg font-semibold`                     | "Projects", "Billing", "Settings", a project's name                            |
| Card or subsection (`h3`, `h4`)        | `text-base`, inside `CardTitle`             | "New project", settings sections, the danger zone                              |
| Body                                   | default (`text-base` via the browser)       | content                                                                        |
| Secondary text, help, status           | `text-sm text-muted-foreground`             | descriptions, "Includes a {n}-day free trial" (billing), `role="status"` lines |
| Labels, buttons                        | `text-sm font-medium` (from the components) | `FieldLabel`, `Button`                                                         |
| Badges                                 | `text-xs font-medium`                       | `Badge`                                                                        |

**Heading outline (Current, settings page):** one `h1` per page; inside the tenant shell the tenant's name is the `h1` and each page starts at `h2`; sections step down one level, and a section inside another (the danger zone's forms) uses the next level, so the outline has no gaps (`Section` in [`t.$tenant.settings.tsx`](../../../apps/app/src/routes/t.$tenant.settings.tsx)). Keep that when adding a page.

## Long text

Names typed by people can be long and unbroken. Titles and list items that show them use `wrap-anywhere` (project names on both project pages) so they wrap at 320 px instead of scrolling sideways (Current). Buttons are `whitespace-nowrap`; keep their labels short.

## Not settled

No line-length limit, no type tokens, no display sizes. A page that needs one starts from the classes above and, if a convention emerges across pages, it's proposed for `AGENTS.md` "UI".
