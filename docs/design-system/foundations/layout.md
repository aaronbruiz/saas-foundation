# Layout, spacing and responsiveness

**Source:** the frames in [`components/ui/auth-layout.tsx`](../../../apps/app/src/components/ui/auth-layout.tsx), [`routes/t.$tenant.tsx`](../../../apps/app/src/routes/t.$tenant.tsx), [`routes/account.tsx`](../../../apps/app/src/routes/account.tsx), [`lib/legal-page.tsx`](../../../apps/app/src/lib/legal-page.tsx), and the footer column map in [`routes/__root.tsx`](../../../apps/app/src/routes/__root.tsx). Spacing uses Tailwind's default scale; there are no spacing tokens.

## Frames

A page picks its frame and doesn't copy the frame's classes (the `ui-page` skill). Each frame sets the content column:

| Frame            | Column                                                                | Used by                                                                               |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `AuthLayout`     | `max-w-sm`, `px-2.5` below `sm`, `px-4` above; a card from `sm` up    | sign-in, sign-up, password reset, invitation, new organization (Rule: AGENTS.md "UI") |
| Tenant shell     | `max-w-3xl p-8`, header with the organization menu and two nav groups | everything under `/t/<slug>/`                                                         |
| Account          | `max-w-xl`, `p-4` below `sm`, `p-8` above                             | `/account`                                                                            |
| Legal page       | `max-w-3xl p-8`                                                       | privacy, terms, subprocessors                                                         |
| Not found, error | `max-w-xl p-8`                                                        | the root's `NotFound`, `ErrorPage`                                                    |

The footer lines up with the page's column (`footerColumns` in `__root.tsx`); a new frame adds its column there.

## Why the auth frame is so narrow at 320 px

Turnstile's widget is a fixed 300 px wide. On a 320 px screen that leaves at most 10 px a side, so below `sm` the auth card goes flat and edge to edge, and its overflow stays visible so focus rings aren't clipped. Pages without Turnstile use the same frame so every auth page looks alike (Current, comment in `auth-layout.tsx`).

## Spacing in use

Vertical rhythm inside a page is a flex column with `gap-6` between sections and `gap-4` between fields; button rows are `flex flex-wrap gap-3`. These are consistent across the tenant pages (Current) but not a rule.

## Responsive behaviour

- Pages are checked at **320 and 1280 px** (visual tests). Nothing may scroll sideways at 320.
- Rows of actions and the nav groups use `flex-wrap`; the tenant nav keeps page links and account links in two groups so no wrapped row mixes them.
- Touch and pointer targets: a link on its own line, or in a menu or popover, is at least 24 px tall (`min-h-6`, WCAG 2.5.8; Rule, AGENTS.md "UI"). List rows that are links are 44 px (`min-h-11`, the projects list; Current).

## Not settled

No grid system, no breakpoint tokens beyond Tailwind's, no sidebar layout. A product with denser pages proposes its own in `docs/product/`.
