# ADR-0016: Transactional email: Cloudflare Email Service behind an app mailer

Status: Accepted (owner decision 2026-09-28, Q7). Delivery activation pending the sending domain. · Date: 2026-09-28

Superseded in part by [ADR-0024](0024-email-activation-send-email-binding.md): activation step 3 (binding, previews, where the production settings live).

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
- **Email verification:** sent on sign-up, and **required** (enforced 2026-10-01, once production delivery was live and before the ADR-0014 data gate lifts; owner decisions in the PR):
  - `requireEmailVerification` (email + password sign-in) and `requireEmailVerificationOnInvitation` (accepting or rejecting an invitation; this also covers sessions created before enforcement).
  - **Sign-up** creates no session. Better Auth then answers every sign-up alike, including an existing address or one refused by the ADR-0014 allowlist (no user, no email). The page says "Check your email".
  - **Resend = sign in.** A sign-in with the right password and an unverified address is refused (`403 EMAIL_NOT_VERIFIED`) and sends a fresh link (`sendOnSignIn`, under the login rate limit). There is no separate resend endpoint in the UI.
  - **No auto sign-in** after verifying (`autoSignInAfterVerification: false`): the link proves the mailbox, and the password still creates the session.
  - **The link lands on** `/login?verified=1&redirect=<same-site path>` (built with `URLSearchParams` from `safeRedirect`). An invalid or expired link lands there with `error`, and the page shows a fixed message (never the parameter's text). A link resent by sign-in lands on `/` (Better Auth's client would follow a sign-in `callbackURL` on success too).
  - **Previews only:** `EMAIL_VERIFICATION=off` (passed by `scripts/preview/lib.sh`), because previews send no email. The app honours `off` only when `BETTER_AUTH_URL` is a workers.dev URL; anywhere else it logs `auth.email_verification_off_refused` and keeps verification on. Any other value, or unset, means on. CI fails if `wrangler.jsonc` sets it, and `pnpm run deploy` refuses while the production Worker has an `EMAIL_VERIFICATION` secret (`scripts/check-email-verification.mjs`).
  - **E2E mailbox:** verification links are JWTs signed with `BETTER_AUTH_SECRET`. The Playwright runner reads the secret from `apps/web/.dev.vars`, signs the same link with Better Auth's exported `createEmailVerificationToken`, and the browser follows it through the real `/api/auth/verify-email`. The secret never leaves the runner's Node process. The emailed link itself is covered by Vitest, which captures `sendEmail`. The preview E2E (no secrets) runs with verification off.
  - **Rollout:** existing sessions of unverified users stay valid until revoked, so the owner deletes them once after deploying (runbook "Email" step 5).
- **Invitations** are emailed when delivery is on, and the inviter still gets the shareable link.

## Activation (owner steps first, then a PR)

1. **Owner:** confirm Workers Paid in the dashboard. _(Done 2026-09-29: the owner verified Workers Paid on the production account, ADR-0017.)_
2. **Owner:** production domain on a Cloudflare zone, then `wrangler email sending enable <domain>` (adds SPF/DKIM).
3. **PR:**
   - add `send_email` binding `EMAIL` with `allowed_sender_addresses: [EMAIL_FROM]`;
   - add a `previews` override so preview code can't email real people (the override shape is [to confirm]; invariant 14);
   - set `EMAIL_DELIVERY=cloudflare` and `EMAIL_FROM` for production only;
   - run `cf-typegen`.
4. Smoke test: a reset email and an invitation email arrive at owner-controlled addresses, and SPF/DKIM pass. Only real addresses you control: bounces hurt sender reputation.

## Consequences

- Password reset and verification work end to end in tests; enforced verification is exercised by Vitest and by the local/CI E2E suite, not by preview E2E. In dev they print to the console. In previews and production nothing is sent until activation.
- The provider lock-in is one file.
- Deliverability (SPF/DKIM/DMARC, bounces, suppression) becomes an operational concern at activation.
