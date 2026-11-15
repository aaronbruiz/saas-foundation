# Email: Cloudflare Email Service

## Responsibility

Transactional email for Better Auth: email verification, password reset and organization invitations. Templates and the choice of delivery are ours, behind one `Mailer` in [`server/email.ts`](../../apps/app/src/server/email.ts); Cloudflare Email Service, through the `send_email` binding `EMAIL`, delivers in production ([ADR-0016](../adr/0016-transactional-email.md), [ADR-0024](../adr/0024-email-activation-send-email-binding.md)). No other code sends email (Code Review Rules). Sending is synchronous within the request (no queue).

## Owning files

| File                                                                                  | Role                                                                                     |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`apps/app/src/server/email.ts`](../../apps/app/src/server/email.ts)                  | `render` (the three templates, HTML-escaped) and `mailerFor` (delivery by configuration) |
| [`packages/auth/src/auth.ts`](../../packages/auth/src/auth.ts)                        | which Better Auth events send what (`AuthEmail` kinds)                                   |
| [`apps/app/src/server/auth.ts`](../../apps/app/src/server/auth.ts) (`invitationLink`) | the invitation link: `<BETTER_AUTH_URL>/invite/<id>`                                     |

Tokens go in the query string, never the URL path (Code Review Rules).

## Configuration

| Name             | Values and meaning                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_DELIVERY` | `cloudflare`: send through `EMAIL` from `EMAIL_FROM`. `console`: print the message, links included, **only** in a Vite dev build on a localhost URL (refused otherwise). Unset: nothing is sent, a warning is logged. |
| `EMAIL_FROM`     | the sender address, one of the binding's `allowed_sender_addresses`                                                                                                                                                   |
| `EMAIL` binding  | [`apps/app/wrangler.jsonc`](../../apps/app/wrangler.jsonc) `send_email`; previews never get it                                                                                                                        |

## Environments

| Environment | Delivery                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local       | `console` (`.dev.vars.example`): read links in the `pnpm dev` terminal; E2E builds the verification link itself ([`e2e/mailbox.ts`](../../apps/app/e2e/mailbox.ts)) |
| Preview     | none, and verification is off there                                                                                                                                 |
| Production  | `cloudflare`, once the owner set both secrets (runbook "Email")                                                                                                     |

## Data exchanged

The recipient's address, the subject and the body, which can contain an organization's name and a link carrying a token. Logs never include the address or subject: only the kind of message (ADR-0015).

## Failures

| Situation                                                                               | Effect                                                                                                                        | Log event                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Delivery unset                                                                          | nothing is sent; the auth operation itself succeeds                                                                           | `email.delivery_disabled` |
| Misconfigured (`cloudflare` without the binding or sender, `console` outside localhost) | the send fails; the auth request isn't broken for everyone                                                                    | `email.misconfigured`     |
| The binding refuses or errors                                                           | the send fails                                                                                                                | `email.send_failed`       |
| Accepted by the binding, never received                                                 | not visible to the app: acceptance isn't delivery. Check the recipient's spam folder and the sending domain (runbook "Email") | none                      |

An invitation stays valid whatever happened to its email: `inviteMember` returns the link to the inviter, who can pass it on. A verification or reset email that didn't arrive can be requested again from the sign-in and forgot-password pages.

## Retry safety

Requesting another verification or reset email sends a new message. Verification links are signed and stay valid until they expire, so an earlier one can still work (ADR-0044 decision 2 "Limits"); whether an earlier reset link still works isn't documented here (not verified). A send that failed is safe to request again: nothing about the account changed because of it.

## Tests and operations

- Tests: [`email.test.ts`](../../apps/app/test/email.test.ts) (templates, each delivery mode, verification, reset, invitation email).
- Runbook: ["Email"](../runbooks/README.md#email-adr-0016-adr-0024) (secrets, smoke test, turning it off, changing the sender).
- [Troubleshooting: an email doesn't arrive](../troubleshooting/README.md#an-email-doesnt-arrive).
