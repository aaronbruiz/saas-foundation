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
3. Cancel closes it and returns focus to the page's button: the form's submit opened the dialog, not a `Trigger`, so the page passes that button as `finalFocus`. The final action is `destructiveSolid`. Confirming closes the dialog and then sends the request; the form's buttons stay disabled until the answer arrives.
4. Success: a toast and a refreshed page; failure: the form's error.

Proved by the keyboard pass: Tab stays inside the dialog, Cancel and Escape close it, focus returns to the page's button, and nothing is sent ([`visual/keyboard.visual.ts`](../../../apps/app/visual/keyboard.visual.ts)). E2E scopes to the `alertdialog` when a name repeats behind it (the `ui-page` skill).

## What the dialog guarantees and what it doesn't

The primitives trap focus, restore it to the trigger on close, label the dialog from its title and description, and close on Escape. They don't:

- **cancel the server's work.** Closing a dialog after its action was sent doesn't undo the request; keep the action disabled until the answer arrives (the transfer form does) and show the result on the page. Keeping the dialog open with the failure inside it, as Primer's delete pattern suggests, is a **Proposal**, not what the app does.
- **move focus somewhere sensible when the trigger is gone.** If the action removed the item whose button opened the dialog, the page moves focus to a stable place (the list or the page heading). No page does this yet (**Gap**: removal of a member or project isn't behind a dialog today).
- **render without inline styles on the server.** They render under the CSP as configured (`CSPProvider` in `__root.tsx`); a new dialog page still goes through e2e and visual tests.

## Known gaps

Organization deletion is confirmed by typing the name, not by a dialog. Project deletion, member removal, invitation revocation and account deletion have no confirmation dialog: the `ui-page` skill's step for irreversible actions asks for one ([destructive actions](../patterns/destructive-actions.md)). These are candidates for separate changes, not examples to copy.
