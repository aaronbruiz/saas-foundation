# Motion

There's no motion system: no timing tokens and no rule. This page records what moves today and what isn't known.

## What moves (Current)

| Where                                                 | Motion                                                                                         | Source                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Dialog, alert dialog, menus, popover, select, tooltip | fade and zoom in and out, about 100 ms (`data-open:animate-in`, `animate-out`, `duration-100`) | the components, through `tw-animate-css` |
| Toasts                                                | sonner's own slide and fade                                                                    | `sonner`                                 |
| Skeleton                                              | `animate-pulse`                                                                                | `skeleton.tsx` (not used by a page)      |
| Buttons                                               | a 1 px press offset and colour transitions                                                     | `button.tsx`                             |
| Organization menu chevron                             | rotates when open                                                                              | `t.$tenant.tsx`                          |

## Reduced motion

- sonner's stylesheet has a `prefers-reduced-motion` block (read in the installed 2.0.8).
- `tw-animate-css` (1.4.0) has none, so [`styles.css`](../../../apps/app/src/styles.css) ends with one rule for the whole app: under `prefers-reduced-motion: reduce`, every animation and transition takes 0.01 ms (Current). Near-zero rather than `animation: none`, so the end events Base UI waits for before unmounting a closed overlay still fire. It covers the overlays, the chevron, the skeleton and the buttons' transitions. No CSP change: it's in the app's stylesheet.
- Not verified with the setting turned on in a browser beyond the e2e and visual runs, which don't emulate it.

New motion is covered by that rule as long as it's CSS animation or transition; anything else (script-driven motion) has to honour `prefers-reduced-motion` itself (Proposal, following WCAG 2.3.3's intent; not an `AGENTS.md` rule).
