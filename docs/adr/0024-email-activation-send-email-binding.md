# ADR-0024: Activate transactional email: the `send_email` binding `EMAIL`

Status: Accepted (owner decisions 2026-09-30). Production secrets set and smoke test passed 2026-10-01 (runbook "Email"). · Date: 2026-09-30

Supersedes in part [ADR-0016](0016-transactional-email.md): its "Activation" step 3 (the binding, the previews override "[to confirm]", where `EMAIL_DELIVERY` and `EMAIL_FROM` live).

## Context

- ADR-0016 decided the mailer seam (`apps/web/src/server/email.ts`), delivery by `EMAIL_DELIVERY`, and an activation sequence. Its steps 1 (Workers Paid) and 2 (sending domain) are done: the owner enabled Email Sending for **`mail.aaronlabr.dev`** on the `aaronlabr.dev` zone (`wrangler email sending list`: enabled, 2026-09-30). That is this binding's trigger (AGENTS.md invariant 14).
- PR previews deploy through the trusted gate `scripts/preview/prepare-config.mjs` (ADR-0021), which refuses any binding but the Hyperdrive `DB`. A `send_email` binding in the committed config would make every preview fail, and a preview that kept it could send mail from our domain with PR code.
- Wrangler's `send_email` binding can restrict senders (`allowed_sender_addresses`) and recipients (`destination_address`, `allowed_destination_addresses`, verified addresses only).
- The preview gate refuses `vars` in the config (previews set theirs with `--var`), so production-only settings can't be plain config values.

## Decision

1. **Binding** in `apps/web/wrangler.jsonc`: `send_email` `EMAIL`, `allowed_sender_addresses: ["no-reply@mail.aaronlabr.dev"]`. No recipient restriction in production (invitations and resets go to users).
2. **Sender:** `SaaS Foundation <no-reply@mail.aaronlabr.dev>` (owner). No Reply-To for now; if replies become useful, add `Reply-To: support@aaronlabr.dev` in the mailer (with Email Routing for that address).
3. **Previews never get the binding.** The gate accepts `send_email` only if it equals the committed value exactly (a constant in `prepare-config.mjs`, updated together with `wrangler.jsonc`), then deletes it before `wrangler preview` runs; the `previews` block stays DB-only, so a `previews.send_email` entry is refused too. `wrangler preview` runs with `--ignore-base-config`, so a binding in the dashboard's Preview base config can't reach a preview either. The preview deploy also sets no `EMAIL_DELIVERY` (`scripts/preview/lib.sh` passes only `BETTER_AUTH_*` and `SIGNUP_MODE`), so their mailer is disabled twice over. The gate runs from the default branch (`workflow_run`), so a PR that changes the committed value is refused until it merges.
4. **Production settings** are Worker secrets set by the owner on the production Worker only: `EMAIL_DELIVERY=cloudflare`, `EMAIL_FROM=no-reply@mail.aaronlabr.dev`. Without them delivery stays disabled (ADR-0016), so deploying this binding changes nothing until they're set.
5. **Local development and tests** keep `EMAIL_DELIVERY=console` or unset; the binding has no `remote: true`, so local runs never reach the real service.
6. **Smoke test** (ADR-0016 step 4, runbook "Email"): a password-reset email and an invitation email arrive at owner-controlled addresses, from the address above, with SPF and DKIM passing. Only real addresses the owner controls (bounces hurt the domain's reputation).
7. **Not in this decision:** enforcing email verification (`requireEmailVerification`, `requireEmailVerificationOnInvitation`). ADR-0016 ties it to delivery being live and to an E2E mailbox strategy; it gets its own change before the ADR-0014 data gate is lifted.

## Consequences

- Production email goes out once the two secrets are set; turning it off is deleting the `EMAIL_DELIVERY` secret, which creates a new Worker version without a code deploy.
- Changing the sender means changing `wrangler.jsonc` and the gate's constant in the same PR.
- Deliverability (SPF/DKIM/DMARC, bounces, suppression) is now operational: see the runbook.
