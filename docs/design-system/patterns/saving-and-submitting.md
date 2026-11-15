# Saving and submitting

Every form that changes something: creating, renaming, inviting, accepting, signing in.

## Before submitting

**Rules:** the form posts (`method="post"`) and its submit is disabled until hydrated, so nothing is sent as a GET (invariant 8); HTML constraints help the person typing, the server decides (ADR-0046 decision 7). Saving is explicit: every form has its own submit button, and nothing saves on change (Current; Primer's [saving](https://primer.style/product/ui-patterns/saving/) recommends the same for text inputs and native selects, read 2026-11-15).

Make the scope of the submit clear: one form, one button, its label naming the action ("Save name", "Create project"). A page with several forms (settings) gives each its own section and button.

## Pending

| Page or action                                                                          | While waiting (Current)                                                                                              |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Sign-in, sign-up, password reset, account forms, all of settings                        | the submit is disabled (`busy`) and a second submit is ignored (`useAction` in settings, a `pending` ref on account) |
| Project create and save, invitation accept, billing buttons, member and invitation rows | **Gap:** disabled only until hydration; a second click sends a second request                                        |

A disabled button prevents a second click from this page; it isn't server-side deduplication. Whether a repeated request is harmful depends on the operation: a second "Create project" creates a second project; a second invitation acceptance is a 404; a second checkout opens a second session ([billing](../../integrations/billing.md#retry-safety)).

**Proposal** (research scenario 1): every action shows that it's pending, at least by disabling its control, and the same request can't be sent twice from the page. Words such as "Saving…" are optional; there's no spinner component (progress is excluded by the CSP).

## Result

Feedback in proportion to the change (Current):

- The result is visible where the person is: nothing more (a new project appears in the list, a renamed project's heading changes).
- The result isn't visible: a success toast ("Name saved.", "Ownership transferred to …").
- The result replaces the form: a `role="status"` message ("We sent a verification link to …").
- The task continues elsewhere: navigate there (accepting an invitation opens the organization's projects; creating an organization opens it).

Don't announce a larger task as done when only a request was accepted: an invitation sent isn't a member joined, a checkout opened isn't a subscription ([invitations](invitations-and-access.md), [billing handoffs](billing-handoffs.md)).

## Failure

The form keeps what the person typed, and the error goes where AGENTS.md "UI" says: at the field for invalid input, a form-level alert for anything else ([errors and recovery](errors-and-recovery.md)). Toasts never carry errors.

## Unknown outcome

A request can reach the server and commit, and its answer still be lost (a dropped connection, a timeout). The page then can't tell success from failure.

- **Rule (AGENTS.md "Working rules", for operators):** an external mutation whose result is unclear is UNKNOWN until checked; it isn't retried blindly.
- **Current, in the interface:** account deletion and organization deletion distinguish it. Answers that prove nothing changed get their reason; anything else says "We couldn't confirm your account was deleted. Try signing in again to check." ([`account.tsx`](../../../apps/app/src/routes/account.tsx)) or "We couldn't confirm <name> was deleted. Reload the page to check, and try again if it's still there." (`deleteFailure` in [`t.$tenant.settings.tsx`](../../../apps/app/src/routes/t.$tenant.settings.tsx), with the known refusals in [`lib/deletion-refusals.ts`](../../../apps/app/src/lib/deletion-refusals.ts)). Other pages show the error's message, which for a lost response is the generic "Something went wrong" from `messageOf`.
- **What a person can do today:** reload the page and look. The loaders read fresh data on every load (uncached database), so the page shows what committed.
- **Proposal:** where a repeat would duplicate something (create), say "It may have been saved. Check the list before trying again." rather than inviting a retry. Not implemented; no idempotency keys, polling or undo exist, and none is implied here.

## Interruption and unsaved work

Leaving a page, reloading or switching organization discards anything typed and not submitted. No page warns about unsaved changes (Current). The forms are short today (a name, a reference), so the loss is small; a long form would need its own decision on warning or drafts (research scenario 2; drafts need a privacy and storage decision and never apply to passwords or secrets). Closing a dialog before confirming sends nothing; after confirming, the request continues.

## Focus and announcements

- Field and form errors are `role="alert"` and announced when they appear; focus stays where it was (Current; Not verified with a screen reader).
- Success toasts don't take focus (keyboard pass, settings).
- `role="status"` results are announced politely (WCAG 4.1.3).
- Proposal: after a failed submit on a long form, move focus to the first invalid field or the alert.
