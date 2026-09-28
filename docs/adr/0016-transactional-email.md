# ADR-0016: Transactional email: Cloudflare Email Service behind an app mailer

Status: Accepted (owner decision 2026-09-28, Q7). Delivery activation pending the sending domain. · Date: 2026-09-28

## Context

Auth needs three emails: invitations, password reset, and email verification. The app runs on Cloudflare Workers, and Cloudflare Email Service offers a native `send_email` Worker binding (no API keys).

- Outbound Email Sending requires **Workers Paid**. The owner confirmed Workers Paid on 2026-09-27. The logged-in Wrangler session can't read billing, so it can't be re-checked from the API; the owner verifies it in the dashboard before activation. If production ever stays on Workers Free, propose the smallest external transactional provider (HTTPS API, secret in Worker env) instead.
- No sending domain is set up yet. Email Sending needs the domain onboarded on a Cloudflare zone (SPF/DKIM), which waits for the production custom domain.

## Decision

- **One seam** (`apps/web/src/server/email.ts`):
  - `packages/auth` hands the app typed `AuthEmail`s (`invitation`, `password-reset`, `verification`);
  - the app renders them (text + HTML-escaped HTML) and delivers them through a `Mailer`;
  - changing provider means one new `Mailer`, no auth changes.
- **Delivery by `EMAIL_DELIVERY`:**
  - `cloudflare`: the `EMAIL` binding, from `EMAIL_FROM`.
  - `console`: local dev only; prints the message and links. Refused unless it's a Vite dev build (`import.meta.env.DEV`, false in every production bundle) **and** `BETTER_AUTH_URL` is `http://localhost`, so tokens can't reach deployed logs even if misconfigured.
  - unset: disabled. Nothing is sent; a warning with only the email kind is logged (subjects can contain organization names). This is the default for previews and for production until activation.
  - A misconfiguration fails the send and is logged; it doesn't break every auth request.
- **No Queues.** Sends run after the response via the Worker's `waitUntil` (Better Auth `advanced.backgroundTasks`), not in a queue. This also removes a timing oracle: awaiting the send only for existing accounts would reveal which addresses have one. A failed send is logged (`email.send_failed`) and not retried. If reliable asynchronous delivery or retries become a requirement, that gets its own ADR (ADR-0007 trigger for Queues).
- **Tokens only in query strings** (ADR-0015 logs keep URL paths):
  - Reset emails link to our page `/reset-password?token=…`, which moves the token into memory and drops it from the address bar. Better Auth's default link has the token in the path.
  - Verification links use Better Auth's `/api/auth/verify-email?token=…`.
- **Password reset:**
  - all other sessions are revoked;
  - the request answers the same whether or not the account exists;
  - Better Auth's built-in limits apply (3 per 60 s per IP on reset and verification requests).
- **Email verification:** sent on sign-up. **Not yet required** to sign in or to accept invitations.
  - Trigger to enforce it (`requireEmailVerification`, `requireEmailVerificationOnInvitation`): production email delivery is live, and before the ADR-0014 data gate is lifted.
  - It needs an E2E mailbox strategy, because the Playwright flow signs up users.
- **Invitations** are emailed when delivery is on, and the inviter still gets the shareable link.

## Activation (owner steps first, then a PR)

1. **Owner:** confirm Workers Paid in the dashboard.
2. **Owner:** production domain on a Cloudflare zone, then `wrangler email sending enable <domain>` (adds SPF/DKIM).
3. **PR:**
   - add `send_email` binding `EMAIL` with `allowed_sender_addresses: [EMAIL_FROM]`;
   - add a `previews` override so preview code can't email real people (the override shape is [to confirm]; invariant 14);
   - set `EMAIL_DELIVERY=cloudflare` and `EMAIL_FROM` for production only;
   - run `cf-typegen`.
4. Smoke test: a reset email and an invitation email arrive at owner-controlled addresses, and SPF/DKIM pass. Only real addresses you control: bounces hurt sender reputation.

## Consequences

- Password reset and verification work end to end in tests. In dev they print to the console. In previews and production nothing is sent until activation.
- The provider lock-in is one file.
- Deliverability (SPF/DKIM/DMARC, bounces, suppression) becomes an operational concern at activation.
