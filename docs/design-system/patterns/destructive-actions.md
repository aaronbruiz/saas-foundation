# Destructive actions

Deleting, removing, revoking, leaving and handing over ownership. They look alike on screen and aren't: what's lost, who else is affected and what can be recovered differ ([domain model: deletion](../../architecture/domain-model.md#deletion)).

## Context and prerequisites

| Action                  | Who can                                        | Consequence                                                                                  | Recovery in the app                  | Current confirmation                                                                                     |
| ----------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Delete a project        | owner, admin (`project:delete`)                | the project and its data are gone for the organization (archived for operators, ADR-0039)    | none                                 | `AlertDialog` naming the project and its consequence, `destructiveSolid` final action                    |
| Remove a member         | owner, admin (`member:manage`); never an owner | they lose access; their work stays                                                           | invite again                         | none                                                                                                     |
| Revoke an invitation    | owner, admin (`member:invite`)                 | the link stops working                                                                       | invite again                         | none                                                                                                     |
| Leave an organization   | any member; not a sole owner                   | you lose access                                                                              | be invited again                     | none                                                                                                     |
| Transfer ownership      | an owner                                       | the other member becomes an owner and you an admin                                           | the new owner transfers back         | `AlertDialog`, `destructiveSolid` final action                                                           |
| Delete the organization | an owner                                       | everything in it, for every member; refused while billing is live or a checkout may complete | none                                 | `AlertDialog` listing the consequences, then the exact name typed in it, `destructiveSolid` final action |
| Delete your account     | the user                                       | deactivated at once, you leave every organization, data purged later (ADR-0044)              | none; sign up again as a new account | `AlertDialog` stating the consequences, the password typed in it, `destructiveSolid` final action        |

**Rules:** page and row buttons are the tinted `destructive` variant; `destructiveSolid` only as the final action of an `AlertDialog` confirming something that can't be undone or that hands over ownership. Which actions are confirmed is decided by consequence (AGENTS.md "UI", owner 2026-11-15): deleting what the app can't restore (a project, an organization, your account) and transferring ownership go through an `AlertDialog` that names the object and its consequence, stays open until the answer, and ends in `destructiveSolid`; organization deletion also takes its typed name, account deletion its password. Removing a member, revoking an invitation and leaving can be redone (invite again), so they aren't confirmed: they show their pending state and their result. The `ui-page` skill cites the rule (ADR-0042 decision 2).

## Choosing the friction

Friction in proportion to consequence (Primer's [delete pattern](https://primer.style/product/scenario-patterns/delete/), read 2026-11-15, recommends the same: no confirmation for reversible actions, a dialog for one resource, typing a name for the widest ones). In this app's terms (Rule, AGENTS.md "UI"; the examples are Current):

- Reversible, or easily redone (revoke, remove a member, leave): an immediate action with a clear result, no dialog ([`t.$tenant.members.tsx`](../../../apps/app/src/routes/t.$tenant.members.tsx), `LeaveSection`).
- One resource that can't be recovered (a project): an `AlertDialog` naming it, Cancel focused first (`DeleteProjectDialog`, [`t.$tenant.projects.$id.tsx`](../../../apps/app/src/routes/t.$tenant.projects.$id.tsx)).
- Everything for everyone (an organization) or your whole account: the consequences in words, then the typed name (organization) or the password (account), both in the dialog (`DeleteDialog` in settings, `DeleteAccountDialog` in [`account.tsx`](../../../apps/app/src/routes/account.tsx)).

Name the action and its object on the final button ("Delete project", not "OK"); say "Remove" when the thing still exists elsewhere (a member), "Delete" when it's destroyed (content).

## Pending, result and failure

- **Pending:** the action stays disabled until the answer, and says so ("Deleting…", "Removing…", "Revoking…"); on the members page one row action runs at a time (Current; `usePending` in [`lib/ui.tsx`](../../../apps/app/src/lib/ui.tsx), settings' own `useAction`).
- **Result:** go to where the person can continue: deleting a project navigates to the project list (replacing the history entry, so Back doesn't land on its 404); leaving or deleting an organization goes to `/`; deleting an account goes to `/`. A removed row disappears from the refreshed list.
- **Refusals that change nothing** are form-level alerts with the reason: "You're the only owner. Transfer ownership or delete the organization first."; "This organization has an active subscription. Cancel it in Billing first."
- **Partial outcomes are said:** a transfer that promoted the new owner but couldn't demote you says so ("The new owner is in place, but you're still an owner. …"); an account deletion refused part-way lists the organizations you already left.
- **Unknown outcome:** the project, organization and account dialogs stay open while the request runs and show the result in it; project deletion's answer other than `forbidden` reads "We couldn't confirm <name> was deleted. Reload the page to check, and try again if it's still there."; for organization deletion, an answer that isn't one of the known refusals ([`lib/deletion-refusals.ts`](../../../apps/app/src/lib/deletion-refusals.ts)) reads "We couldn't confirm <name> was deleted. Reload the page to check, and try again if it's still there." Account deletion's "We couldn't confirm your account was deleted. Try signing in again to check." works the same way, when the answer can't establish what happened ([saving and submitting](saving-and-submitting.md#unknown-outcome)).

## Interruption

Closing a dialog after confirming doesn't cancel the request. A deletion refused because a checkout may still complete stays refused until the provider says it's finished; that's the guarantee, not a fault ([billing handoffs](billing-handoffs.md)). There's no undo anywhere; don't promise one.

## Focus and announcements

- After the item that had focus is removed, focus goes to its list's heading ("Members" or "Pending invitations"; Current, from Primer's delete pattern; e2e for revoking, not for removing a member; Not verified with a screen reader).
- After a navigation, focus starts at the new page (the router's default behaviour; Not verified with a screen reader).
- Failures use `role="alert"`; a transfer's success is a toast that doesn't take focus (keyboard pass).
