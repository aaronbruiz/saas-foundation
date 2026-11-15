# Navigation

Links, the tenant navigation, menus, popovers and tabs.

## Links

Navigation is a `Link` from TanStack Router (or `<a>` off the app). Links in text are underlined `text-primary` (`authInlineLink`); a link on its own line, or in a menu or popover, is at least 24 px tall (`authStandaloneLink`, `min-h-6`; Rule, AGENTS.md "UI", WCAG 2.5.8). Don't make a link look like a button unless it starts a task (`buttonVariants` on a link), and never make a button do a link's job ([buttons](buttons.md#button-or-link)).

## Tenant navigation (Current)

The tenant shell ([`t.$tenant.tsx`](../../../apps/app/src/routes/t.$tenant.tsx)) has two groups of links on the `sidebar-*` tokens: the tenant's pages, and Account plus Sign out. The current page's item is filled, and the router sets `aria-current` on it. Links the member's role can't use (Invite, Billing) are hidden from the capabilities the layout loaded; the server checks again on every call (invariant 4).

The **organization menu** is a native `<details>`/`<summary>` showing the tenant's name as the page's `h1`, with the member's other organizations and a link to create one. It loads the list when opened, so it isn't held up by every navigation (comment in the file). A `key` closes it when the tenant changes.

## Menus, popovers, tabs (available, unused)

| Component                                                                                                     | For                                                               | Not for                                                      |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `DropdownMenu` ([`dropdown-menu.tsx`](../../../apps/app/src/components/ui/dropdown-menu.tsx), Base UI `menu`) | a list of commands on one object (row actions)                    | navigation between pages (use links), a value (use a select) |
| `Popover` ([`popover.tsx`](../../../apps/app/src/components/ui/popover.tsx))                                  | extra content anchored to a control, with its own focusable parts | essential information (it's hidden until opened)             |
| `Tabs` ([`tabs.tsx`](../../../apps/app/src/components/ui/tabs.tsx)), variants `default`, `line`               | switching views of the same thing on one page                     | separate pages with their own URLs (use links)               |

No page has a menu yet, so its Escape and focus-return checks come with the first page that does ([`docs/testing.md`](../../testing.md)). A menu item that navigates is a link item; one that acts is a button item.

## Back, reload and URLs

Every tenant page has its own URL with the slug, so Back, reload and a shared link work, and each reload re-checks membership. State held only in a component (an open dialog, a half-typed form) is lost on reload or navigation; nothing warns about it today ([saving and submitting](../patterns/saving-and-submitting.md#interruption-and-unsaved-work)).
