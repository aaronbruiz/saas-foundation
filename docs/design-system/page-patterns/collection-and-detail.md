# Collection and detail

**Purpose:** list a tenant's resources, create one, open one, change or delete it. **Frame:** the tenant shell ([`t.$tenant.tsx`](../../../apps/app/src/routes/t.$tenant.tsx)): the organization's name as `h1` with its menu, the page links and the account links; each page starts at `h2`.

The model is the sample project, a foundation resource that a product replaces ([`t.$tenant.projects.index.tsx`](../../../apps/app/src/routes/t.$tenant.projects.index.tsx), [`t.$tenant.projects.$id.tsx`](../../../apps/app/src/routes/t.$tenant.projects.$id.tsx)). Members ([`t.$tenant.members.tsx`](../../../apps/app/src/routes/t.$tenant.members.tsx)) is a collection with row actions and no detail page.

## Collection

1. `h2` with the collection's name.
2. The list: links to each item, 44 px rows, long names wrapping; or the empty sentence ("No projects yet.").
3. A "New project" card with the create form.

Creation is inline on the collection page because the form is short and its result appears in the same list (Primer's [create pattern](https://primer.style/product/scenario-patterns/create/), read 2026-11-15, matches the form to the task's size). The tenant is the one in the header and URL, so it's always visible what the new item belongs to (research scenario 12).

## Detail

1. `h2` with the item's name.
2. A card with the edit form, its Save, and the destructive action if the role allows it (`canDelete` from the layout's capabilities; the server checks again).

## States

| State                                             | Current behaviour                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Another tenant's or unknown item, or not a member | the not-found page (invariant 5; the loader's server call answers 404)                                                                                                    |
| Role can't delete                                 | no Delete button; a direct call answers 403                                                                                                                               |
| Empty collection                                  | a muted sentence and the create form on the same page                                                                                                                     |
| At the plan's limit                               | create refused with the limit and "Upgrade to add more." (403)                                                                                                            |
| Saving                                            | the button is disabled and says "Saving…"/"Creating…" until the answer; a repeated click sends nothing ([saving](../patterns/saving-and-submitting.md#pending))           |
| Create's answer lost                              | "We couldn't confirm the project was created. Check the list before trying again."; input kept, list refreshed                                                            |
| Save failed                                       | the server's message in a `FieldError` after the fields; input kept                                                                                                       |
| Saved                                             | the heading and list update after `router.invalidate()`; no toast, the change is visible                                                                                  |
| Deleted                                           | confirmed in an `AlertDialog` (AGENTS.md "UI"), then navigates to the collection, replacing the history entry ([destructive actions](../patterns/destructive-actions.md)) |
| Edited elsewhere meanwhile                        | last save wins, no warning ([errors and recovery](../patterns/errors-and-recovery.md#stale-pages-and-concurrent-changes))                                                 |
| Navigating away with unsaved edits                | lost without a warning                                                                                                                                                    |
| Loading                                           | none: the loader runs before render                                                                                                                                       |

## Tests

[`e2e/projects.spec.ts`](../../../apps/app/e2e/projects.spec.ts), [`e2e/slice.spec.ts`](../../../apps/app/e2e/slice.spec.ts) (isolation through URLs), [`test/tenancy.test.ts`](../../../apps/app/test/tenancy.test.ts), [`visual/tenant.visual.ts`](../../../apps/app/visual/tenant.visual.ts). Building a new resource on this pattern: [first successful change](../../guides/first-change.md).
