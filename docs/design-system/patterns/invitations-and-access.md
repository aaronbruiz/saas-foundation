# Invitations and access

Joining an organization, who sees what, what happens when a role or session changes, and how limits are explained. The rules here are authorization rules; the interface only explains them ([domain model](../../architecture/domain-model.md#how-a-request-is-authorized)).

## Invitations

**Context:** an owner or admin invites an address with a role ([`t.$tenant.invite.tsx`](../../../apps/app/src/routes/t.$tenant.invite.tsx)); the recipient opens `/invite/<id>` ([`invite.$id.tsx`](../../../apps/app/src/routes/invite.$id.tsx)).

| Step                                  | Current behaviour                                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invite                                | The page shows the invitation link itself as well as sending the email, so a lost email doesn't block anything. Sent isn't joined: the person appears under pending invitations until they accept. |
| Open the link signed out              | Redirected to sign-in, then back to the invitation.                                                                                                                                                |
| The acceptance page                   | `AuthLayout`, "Join organization", "Signed in as <email>.", and one button. It doesn't name the organization: a preview would tell anyone holding the link that it's valid.                        |
| Accept                                | Opens the organization's projects.                                                                                                                                                                 |
| Wrong account, expired, revoked, used | the **same** "not found", by design                                                                                                                                                                |
| No free seats                         | "This organization has no free seats on its plan" (403); said only after Better Auth confirmed the caller is the recipient, so it discloses nothing                                                |

**Rules kept by this pattern:** the merged 404 (invariant 5 and the service's comment); acceptance needs a verified address (ADR-0016).

**Proposals that need an owner decision** (research scenario 4): naming the organization on the acceptance page, telling the recipient to switch accounts, or differentiating expired from wrong-recipient. Each changes what an unauthenticated or wrong visitor learns, so it's a disclosure decision before it's a design one. Until then, the page shows the signed-in email, which lets the person notice a wrong account.

## Permissions, prerequisites and limits

| Why an action isn't available                                          | What the app does (Current)                                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The role lacks the capability                                          | hides the control (Invite, Billing, Delete project, row actions); the server answers 403 if called anyway |
| The plan's limit is reached                                            | the action is shown and refused with the limit and the next step ("Upgrade to add more.")                 |
| A prerequisite (sole owner leaving, live subscription before deletion) | the action is shown and refused with what to do first                                                     |
| Billing for someone who can't manage it                                | the billing page says "Only the organization owner can change the plan."                                  |

**Rules:** the UI may hide, never decide (invariant 4); a limit is the plan's, read from entitlements, and the interface never names a plan to decide anything (invariant 6). Explain a limit with the number the server sent, not one copied into the page.

A disabled control or a tooltip alone isn't an explanation: say why next to it when the person can do something about it (**Proposal**, research scenario 7). Never explain an access boundary in a way that reveals another tenant's resources.

## Session expiry

**Current:** an expired or revoked session makes the next server call answer 401, which the server-function boundary turns into a redirect to sign-in that returns to `/` afterwards, not to the page the person was on ([`server/boundary.ts`](../../../apps/app/src/server/boundary.ts)); the invitation page passes its own return path. Nothing typed is kept across sign-in, and nothing is replayed after it.

**Deferred:** re-authentication before sensitive actions beyond the existing password for account deletion (research scenario 9). Never replay a consequential submission after signing in again; re-check authorization first.

## Role changes while a page is open

Capabilities are read when the page loads. If an owner demotes a member while their page is open, the member still sees the old buttons; the server answers 403 (role lacking) or 404 (membership gone) on the next action. Reloading shows the current role. That's correct and safe; the message is the server's.

## Focus and announcements

The invitation page's failure is a `FieldError` (`role="alert"`) above the button. Not verified with a screen reader.
