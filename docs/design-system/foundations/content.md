# Content

How the app words things, taken from the pages and the accepted rules. Terms come from the [glossary](../../glossary.md); in the interface, say **organization**, not tenant.

## Kinds of message

| Kind               | Where it goes                                                                     | Example in the app                                                             | Source                    |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------- |
| Label              | `FieldLabel`, tied to its input by `htmlFor`                                      | "Project name", "Organization name to confirm"                                 | `components/ui/field.tsx` |
| Hint               | `FieldDescription` or the section's description, before the action                | "You lose access to this organization and its projects."                       | settings                  |
| Field error        | `FieldError` in the field, which gets `data-invalid`; says what to change         | "That doesn't match the organization's name"                                   | Rule: AGENTS.md "UI"      |
| Form-level failure | `role="alert"` (a `FieldError` outside a field), for anything not about one value | "This organization already has a subscription. Use Manage billing."            | Rule: AGENTS.md "UI"      |
| Status             | `role="status"` paragraph, for a result shown in place                            | "We sent a verification link to … Open it, then sign in."                      | sign-up, forgot password  |
| Success            | a toast, success only; or the visible change itself                               | "Name saved.", "Ownership transferred to …"                                    | Rule: AGENTS.md "UI"      |
| Consequence        | before a destructive or ownership action, stated plainly                          | "… becomes an owner, and you become an admin."                                 | settings transfer dialog  |
| Unknown outcome    | says what isn't known and how to find out                                         | "We couldn't confirm your account was deleted. Try signing in again to check." | account                   |

Server messages are written to be shown: server functions send safe, human messages, and the page displays them through `messageOf` ([`lib/ui.tsx`](../../../apps/app/src/lib/ui.tsx)). The router's error page never shows an error's text, because a client-side failure's message can be anything ([`lib/error-page.tsx`](../../../apps/app/src/lib/error-page.tsx)).

## Voice (Current)

Short, plain sentences in the second person; the action first. Say what happened and what to do next ("Transfer ownership or delete the organization first."). No exclamation marks, no blame, no internal codes in the text.

## Action labels

Verb plus object, in sentence case: "Create project", "Accept invitation", "Delete organization", "Leave organization", "Manage billing". The final button of a confirmation repeats the action, not "OK" or "Yes". "Remove" is used for a member (the person still exists), "Revoke" for an invitation, "Delete" for something that's destroyed.

## Not disclosing

Messages never say whether something outside the person's access exists: "This page doesn't exist or you don't have access to it." covers both cases on purpose (invariant 5). A refused sign-up address and an unknown account read like any other answer (identity integration). Keep that wording when adding messages near access boundaries.

## Not settled

No style guide for dates, numbers or plurals (billing uses `toLocaleDateString()`), and no localization: every string is English, inline in the page. A product that needs either defines it in its own `docs/product/` first.
