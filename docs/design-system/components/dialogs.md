# Dialogs

`AlertDialog` ([`alert-dialog.tsx`](../../../apps/app/src/components/ui/alert-dialog.tsx)) and `Dialog` ([`dialog.tsx`](../../../apps/app/src/components/ui/dialog.tsx)), both Base UI, both modal.

## Which one

| Use                                                                                   | Component     | Why                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Confirm an action that can't be undone, or that hands over ownership                  | `AlertDialog` | `role="alertdialog"`: it interrupts, needs an explicit choice, and doesn't close on an outside click. Its final action may be `destructiveSolid` (AGENTS.md "UI"). |
| A short task that belongs to the page but needs focus (edit a detail, pick something) | `Dialog`      | `role="dialog"`, closes with Escape, the close button or outside click. Available, not used yet.                                                                   |
| Anything long, anything with its own URL, or a task people come back to               | a page        | a dialog can't be linked, bookmarked or reloaded                                                                                                                   |

The APG describes both patterns' keyboard and focus model ([dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [alert dialog](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/), read 2026-11-15); that's guidance on the pattern, not evidence this app conforms.

## Example: the ownership transfer

[`t.$tenant.settings.tsx`](../../../apps/app/src/routes/t.$tenant.settings.tsx), `TransferForm`:

1. The page's form holds the choice (a `NativeSelect`) and a tinted submit button. **Submitting only opens the confirmation; nothing is sent yet.**
2. The `AlertDialog` names the consequence in its title and description ("Transfer ownership to …?", "… becomes an owner, and you become an admin.").
3. Cancel closes it and returns focus to the page's button: the form's submit opened the dialog, not a `Trigger`, so the page passes that button as `finalFocus`. The final action is `destructiveSolid`. Confirming sends the request; the dialog stays open, its buttons disabled ("Transferring…"), until the answer (AGENTS.md "UI"), then closes.
4. Success: a toast and a refreshed page; failure: the form's error.

Proved by the keyboard pass: Tab stays inside the dialog, Cancel and Escape close it, focus returns to the page's button, and nothing is sent ([`visual/keyboard.visual.ts`](../../../apps/app/visual/keyboard.visual.ts)). E2E scopes to the `alertdialog` when a name repeats behind it (the `ui-page` skill).

## Example: organization deletion

`DeleteSection` and `DeleteDialog` in [`t.$tenant.settings.tsx`](../../../apps/app/src/routes/t.$tenant.settings.tsx) (owner decisions 2026-11-14, #290):

1. The danger zone's row states the consequence and has a tinted "Delete organization" button that only opens the dialog.
2. The dialog starts with focus on its title, so the consequences are met first; it lists who loses access (with the member count the page loaded, a snapshot), what's deleted and that Polar's billing account is removed.
3. The person types the organization's exact name; the `destructiveSolid` final action stays disabled until it matches, and while the request runs (`aria-busy`). The server checks the name and authorization again.
4. While the request runs, the dialog can't be closed, so its outcome is shown in it: a known refusal ([`lib/deletion-refusals.ts`](../../../apps/app/src/lib/deletion-refusals.ts)) in the field or as a form alert, anything else as an unknown outcome. Success goes to `/` with a toast.
5. Cancel and Escape return focus to the row's button (`finalFocus`); a reopened dialog starts empty.

Tests: [`e2e/settings.spec.ts`](../../../apps/app/e2e/settings.spec.ts), the keyboard pass.

## Example: project and account deletion

`DeleteProjectDialog` ([`t.$tenant.projects.$id.tsx`](../../../apps/app/src/routes/t.$tenant.projects.$id.tsx)) names the project and says it's deleted for everyone in the organization and can't be undone from the app; Cancel has focus first, the final action is `destructiveSolid` "Delete project". `DeleteAccountDialog` ([`account.tsx`](../../../apps/app/src/routes/account.tsx)) starts on its title, restates the consequences and holds the password field. Both stay open while their request runs (Cancel and Escape do nothing), show the outcome in the dialog, and return focus to the page's button on Cancel or Escape. Tests: [`e2e/projects.spec.ts`](../../../apps/app/e2e/projects.spec.ts), [`e2e/account.spec.ts`](../../../apps/app/e2e/account.spec.ts), the keyboard pass.

## What the dialog guarantees and what it doesn't

The primitives trap focus, restore it to the trigger on close, label the dialog from its title and description, and close on Escape. They don't:

- **cancel the server's work.** So a confirming dialog stays open until the answer (AGENTS.md "UI"): the deletion dialogs show the outcome inside it; the transfer closes after the answer and shows it on the page.
- **move focus somewhere sensible when the trigger is gone.** If the action removed the item whose button opened it, the page moves focus to a stable place: a deleted project navigates to the list; a removed member or revoked invitation (no dialog) moves focus to its list's heading.
- **render without inline styles on the server.** They render under the CSP as configured (`CSPProvider` in `__root.tsx`); a new dialog page still goes through e2e and visual tests.

## Which actions are confirmed

AGENTS.md "UI" ("Confirm by consequence", owner 2026-11-15): project, organization and account deletion and ownership transfer are confirmed in an `AlertDialog`; member removal, invitation revocation and leaving aren't, because they can be redone ([destructive actions](../patterns/destructive-actions.md)). A new action that destroys what the app can't restore follows the deletion dialogs above.
