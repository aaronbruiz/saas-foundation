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
- `tw-animate-css` (1.4.0) has none, and no component or page sets `motion-reduce:` classes. So the overlay animations run whatever the visitor's setting (**Gap**, source-inspected; their duration is short, and none moves content across the screen).
- Not verified with the setting turned on in a browser.

A change that adds motion should honour `prefers-reduced-motion` (Proposal, following WCAG 2.3.3's intent; not yet an `AGENTS.md` rule).
