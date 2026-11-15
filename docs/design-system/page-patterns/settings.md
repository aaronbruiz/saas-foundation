# Settings

**Purpose:** change an organization's or an account's properties, and the consequential actions that go with them. **Frames:** the tenant shell for [`t.$tenant.settings.tsx`](../../../apps/app/src/routes/t.$tenant.settings.tsx) and [`t.$tenant.billing.tsx`](../../../apps/app/src/routes/t.$tenant.billing.tsx); the account frame (`max-w-xl`) for [`account.tsx`](../../../apps/app/src/routes/account.tsx).

## Composition (organization settings, Current)

1. `h2` "Settings".
2. One `Section` (a `Card` with an `h3` and a description) per independent form, each with its own submit: Name, then Transfer ownership, each shown only to roles that can use it.
3. A "Danger zone" `section` with an `h3` and one card with a destructive ring, holding Leave and Delete organization as `h4` rows separated by a `Separator`, each with its consequence, its action and its alert.

Each form runs one action at a time (`useAction`: busy, error, which answers are field errors) and keeps its own error. Saving is explicit and per section; nothing saves on change ([saving and submitting](../patterns/saving-and-submitting.md)).

## Actions

| Action              | Who          | Confirmation                                                                                                                     | Result                                                           |
| ------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Rename              | owner, admin | none                                                                                                                             | toast "Name saved."; the header updates                          |
| Transfer ownership  | owner        | `AlertDialog`, `destructiveSolid` ([dialogs](../components/dialogs.md#example-the-ownership-transfer))                           | toast; you're now an admin and the page reflects it              |
| Leave               | any member   | none                                                                                                                             | to `/`; a sole owner is refused with what to do first            |
| Delete organization | owner        | `AlertDialog`: consequences, then the exact name typed in it ([dialogs](../components/dialogs.md#example-organization-deletion)) | to `/`; refused while billing is live or a checkout may complete |

The account page has the same shape: name, password, the person's organizations, and a danger zone with account deletion (password, with the unknown-outcome message, [destructive actions](../patterns/destructive-actions.md)).

The billing page is a settings page whose changes happen at the provider ([billing handoffs](../patterns/billing-handoffs.md)).

## States

| State                                             | Current behaviour                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Role lacks a section's capability                 | the section isn't rendered; the server answers 403 if called                       |
| Invalid value                                     | the field is marked and its `FieldError` says why                                  |
| Refused (state, billing, concurrent owner change) | a form-level alert with the server's message                                       |
| Waiting                                           | that section's buttons disabled                                                    |
| Two sections edited, one submitted                | only that section is sent; the other keeps its unsaved text until the page reloads |
| Unsaved edits on navigation                       | lost without a warning                                                             |

## Tests

[`e2e/settings.spec.ts`](../../../apps/app/e2e/settings.spec.ts), [`e2e/account.spec.ts`](../../../apps/app/e2e/account.spec.ts), [`e2e/billing.spec.ts`](../../../apps/app/e2e/billing.spec.ts), [`visual/keyboard.visual.ts`](../../../apps/app/visual/keyboard.visual.ts) (the settings page's full keyboard pass), [`visual/tenant.visual.ts`](../../../apps/app/visual/tenant.visual.ts), [`visual/account.visual.ts`](../../../apps/app/visual/account.visual.ts), [`test/organization-settings.test.ts`](../../../apps/app/test/organization-settings.test.ts).
