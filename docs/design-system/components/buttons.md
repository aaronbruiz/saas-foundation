# Buttons

`Button` ([`button.tsx`](../../../apps/app/src/components/ui/button.tsx)) wraps Base UI's button. `buttonVariants` gives the same classes to something that isn't a button (a link styled as one).

## Variants

| Variant            | Use                                                                                                                      | Example                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `default`          | the main action of a form or page, one per form                                                                          | "Create project", "Save", "Accept invitation"                                                    |
| `outline`          | a secondary action next to or instead of the main one                                                                    | "Manage billing", "Leave organization"                                                           |
| `secondary`        | a lower-emphasis filled action                                                                                           | no page yet                                                                                      |
| `ghost`            | an action inside a dense row or toolbar                                                                                  | no page yet                                                                                      |
| `destructive`      | **Rule:** page and row actions that remove or delete: tinted, not solid                                                  | "Delete project", "Remove", "Revoke", "Delete organization", "Delete account"                    |
| `destructiveSolid` | **Rule:** only the final action of an `AlertDialog` that confirms an action that can't be undone or hands over ownership | "Transfer ownership", "Delete project", "Delete organization", "Delete account" in their dialogs |
| `link`             | an action that reads like a link but does something in place                                                             | no page yet                                                                                      |

Sizes: `default` (36 px), `xs`, `sm`, `lg`, and square `icon`, `icon-xs`, `icon-sm`, `icon-lg`. Pages use the default size; member rows use `sm` for their actions.

Rules: AGENTS.md "UI" (`destructiveSolid`), ADR-0046 Notes. Contrast for every variant's text and hover state is in `scripts/brand-contrast.mjs`.

## Button or link

A control that **navigates** is a link (`Link` from TanStack Router, or `<a>`): it opens a page, can be opened in a new tab, and is announced as a link. A control that **does something** (submits, opens a dialog, signs out) is a button. Sign out in the tenant nav is a `<button>` styled like the nav links; the nav items are links. A link on its own line or in a menu is at least 24 px tall (`min-h-6`; AGENTS.md "UI").

## States

- **Disabled until hydrated** (Rule, invariant 8): every submit and every action button has `disabled={!hydrated}` (`useHydrated`, [`lib/ui.tsx`](../../../apps/app/src/lib/ui.tsx)). Before hydration a native submit would send the form as a GET.
- **Busy:** every action also disables while its request is pending, with a label saying so ("Saving…") and `aria-busy` (`usePending` in [`lib/ui.tsx`](../../../apps/app/src/lib/ui.tsx), settings' `useAction`; [saving and submitting](../patterns/saving-and-submitting.md)).
- Focus shows the `ring`; `aria-invalid` turns the border destructive; an icon inside is sized by the button.

## What the page still does

The button doesn't prevent a second submission, show progress, or tell anyone what happened. The page owns pending state (`usePending`), the result message and where focus goes when the button's item disappears ([patterns](../patterns/README.md)). A disabled button explains nothing on its own: say why nearby if the person can do something about it.

## Accessible names

Use visible text. When several identical labels share a page (a "Remove" per member), give each an `aria-label` that names its object: `Remove <email>`, `Revoke invitation for <email>` ([`t.$tenant.members.tsx`](../../../apps/app/src/routes/t.$tenant.members.tsx)). E2E finds them by that name.
