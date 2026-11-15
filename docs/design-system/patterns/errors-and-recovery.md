# Errors and recovery

What failed, where the message goes, and what the person can do next. An undifferentiated "try again" for every failure isn't recovery.

## Kinds of failure

| Kind                                           | Where it shows (Current)                                                        | Rule                                    | Example                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| Invalid input the person can correct           | `FieldError` in the field, which gets `data-invalid`                            | AGENTS.md "UI"                          | "That doesn't match the organization's name"                                           |
| The operation was refused (state, role, limit) | a form-level `role="alert"`                                                     | AGENTS.md "UI"                          | "Your plan allows {n} projects. Upgrade to add more." (the number comes from the plan) |
| A dependency is unavailable                    | a form-level alert with the server's message                                    | AGENTS.md "UI"                          | "Billing is not configured", "Sign-in is temporarily unavailable"                      |
| The page can't load                            | the router's error page: "This page couldn't be loaded. Try again, or go home." | `lib/error-page.tsx`                    | a loader failure                                                                       |
| The thing isn't there, or isn't yours to see   | the not-found page: "This page doesn't exist or you don't have access to it."   | invariant 5                             | another tenant's project id                                                            |
| Not signed in                                  | sign-in (then `/`; the invitation page returns to itself)                       | `server/boundary.ts`, the route loaders | `/invite/<id>` while signed out                                                        |

Server functions send messages written to be shown (`HttpError` messages); the page displays them through `messageOf`. The error page never shows an error's text, because a client-side failure's message can be anything.

## Keep what was typed

The forms don't reset on failure (Current): the person fixes the value or tries again without retyping. The create form resets only after success.

## Status codes and what they mean to the person

| Status | Meaning in this app                                                                                       | Recovery to offer                                                   |
| ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 400    | the input was invalid                                                                                     | fix the field                                                       |
| 401    | no session (or the account was deactivated)                                                               | sign in again                                                       |
| 403    | a member whose role lacks the capability, or a plan limit                                                 | say who can do it, or what the limit is and the next step (upgrade) |
| 404    | unknown, not a member, another tenant's, or gone, indistinguishably                                       | go home; the page doesn't say which                                 |
| 409    | the state changed or forbids it (only owner, live subscription, being deleted, a concurrent owner change) | the message says what to do first; some say to check and retry      |
| 503    | a dependency isn't available or configured                                                                | try later; nothing changed                                          |

## Stale pages and concurrent changes

A page shows what was true when it loaded. Meanwhile another member may rename, delete or change roles.

- **Current:** saves are last-write-wins: two people editing the same project both succeed, and the later save wins without a warning. A resource deleted meanwhile answers 404 on the next action. A role lost meanwhile answers 403 (or 404 if membership is gone); the hidden buttons don't update until the page reloads. Owner changes that collide answer 409 "Another owner changed at the same time. Check the members and retry." (ADR-0043).
- **Deferred:** detecting another person's change before overwriting it (Primer's [edit pattern](https://primer.style/product/scenario-patterns/edit/) recommends surfacing the conflict). Conflict semantics are a product and data decision, not an error message.

## Focus and announcements

Errors are `role="alert"`. The error and not-found pages are full pages with an `h1` and links home; focus after the router renders them is the router's (Not verified).
