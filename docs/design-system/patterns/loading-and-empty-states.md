# Loading and empty states

A blank area can mean loading, nothing yet, nothing matching, or a failure. Each needs a different message, and a failure must never look like an empty collection (research scenario 6; Primer's [degraded experiences](https://primer.style/product/ui-patterns/degraded-experiences/) and [empty states](https://primer.style/product/ui-patterns/empty-states/), read 2026-11-15).

## Loading

**Current:** page data comes from route loaders that run before the page renders, on the server for a first load and during navigation for later ones. So pages render with their data and have no loading state of their own; a slow loader delays the navigation. Actions that wait are covered in [saving and submitting](saving-and-submitting.md#pending).

The exception is data fetched after render: the organization menu loads the member's other organizations each time it opens. While it waits it says "Loading organizations…" (`role="status"`); then it shows the other organizations, nothing more when there are none, or the error (`role="alert"`), with "New organization" there throughout; an answer to an earlier opening is dropped (Current, [`t.$tenant.tsx`](../../../apps/app/src/routes/t.$tenant.tsx); research scenario 6).

For content fetched after render, show that it's loading (words, or the unused `Skeleton`), then the content, an empty state or the error: never an empty list while waiting (the organization menu does this; a rule only if another page needs it).

## Empty

| Situation              | Message (Current)                  | Next step                                   |
| ---------------------- | ---------------------------------- | ------------------------------------------- |
| No projects yet        | "No projects yet."                 | the "New project" form is on the same page  |
| No pending invitations | "No pending invitations."          | the Invite page, for members who can invite |
| No organization yet    | `/` sends the person to create one | the new-organization form                   |

Pages use a muted sentence; the `Empty` component is available for a larger first-use state with a title, description and action ([data display](../components/data-display.md#empty-states)). Offer the next action the person is allowed to take, and only that: a member without `member:invite` isn't shown an invite link (the server would refuse it anyway).

**No results** (a filter or search that matched nothing) doesn't exist yet: there's no search or filter. When it comes, say that nothing matched and how to widen the search, not "No projects yet."

## Unavailable

A load failure shows the router's error page, not an empty page ([errors and recovery](errors-and-recovery.md)). A dependency that's off locally or in previews (billing, email) is said in words where the person acts: Upgrade answers "Billing is not configured"; it isn't hidden.

## Focus and announcements

A list that changes after an action (a project created, a row removed) re-renders after `router.invalidate()`; nothing announces the change except the visible result (Current; Not verified with a screen reader). A proposal for removal is in [destructive actions](destructive-actions.md#focus-and-announcements).
