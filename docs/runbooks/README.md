# Runbooks

Starting a new product from this foundation: [start-new-product.md](start-new-product.md).

## Previews (ADR-0021)

**Invariant:** preview resources are created and removed by CI. Normal preview lifecycle operations (create, reset, deploy, revoke) require no human intervention. Manual operations are administrative or recovery procedures only.

- **Per PR:** Neon branch `preview/pr-<N>` (child of `preview-seed` in the preview project, its own `app_owner` password) and Hyperdrive config `saas-pr-<N>` (caching off). Hyperdrive ids are never reused: a closed PR's config is deleted, a reopened PR gets a new one. **Deleting the config is what revokes database access.** A 404 from a deleted Preview URL is not: deleted Previews and their deployment URLs can keep executing (Cloudflare Previews beta).
- **Not previewed:** the release PR (ADR-0029), Dependabot's PRs (CI's check + test is their gate) and PRs that change only `apps/docs/**` (they get a docs preview, ADR-0028).
- **Flow** (`.github/workflows/preview.yml`, `workflow_run` after CI; default-branch code only):
  - `resolve`: the one open same-repo PR whose head is the CI run's commit;
  - `infra` (environment `preview-infra`): `scripts/preview/infra.sh up` creates the branch, or resets its data to the seed, and creates or reuses the guarded config; never sees the artifact;
  - `deploy` (environment `preview`): `scripts/preview/deploy-artifact.sh` validates the artifact (`apps/app/dist` + `packages/db/drizzle` from CI), migrates with the default-branch migrator, patches the config to that id (`prepare-config.mjs`) and runs `wrangler preview`. A refused config lists each reason; a legitimate new key or binding needs the validator updated on `main` first;
  - `e2e`: the default-branch Playwright suite against the URL, then a PR comment.
- **Close** (`preview-cleanup.yml`, `pull_request_target`): `cleanup-preview` runs `scripts/preview/down.sh` (deletes the Preview), then `cleanup-infra` runs `scripts/preview/infra.sh down` (deletes the config, then the branch). Both act only on a PR that GitHub reports closed right now. A preview run and close-triggered cleanup of one PR hold the same lock (`preview-pr-N`, whole workflow, no in-progress cancellation, up to 100 pending runs queued), so cleanup waits for a running preview, E2E included; the janitor skips PRs whose preview run is still active. **Daily janitor:** `janitor.sh` and `infra.sh janitor` do the same for closed PRs a run missed.
- **By hand** (recovery), with the logged-in sessions instead of CI secrets:
  - `CLOUDFLARE_API_TOKEN="$(pnpm --dir apps/app exec wrangler auth token | tail -1)"` (it can do both sides; CI never has one token for both);
  - `NEON_API_KEY` from `~/.config/neon/credentials.json` (`access_token`; it expires quickly, so run any `neon` command without `--api-key` first to refresh it);
  - `GH_TOKEN="$(gh auth token)"`, plus the CI vars (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, `NEON_PREVIEW_PROJECT_ID`);
  - `PR_NUMBER=<n> scripts/preview/infra.sh up` prints the config id; `PR_NUMBER=<n> HD_ID=<id> ARTIFACT_DIR=<dir> scripts/preview/deploy-artifact.sh`; teardown `PR_NUMBER=<n> scripts/preview/down.sh` then `PR_NUMBER=<n> scripts/preview/infra.sh down`. `FORCE=1` skips the PR-state checks (test PR numbers ≥ 9015; 9001–9014 are used).
  - Tested 2026-09-29 (9011–9014): see ADR-0021.
- **Limits:** Neon Free has 10 branches per project (the seed uses one), Hyperdrive 25 configs per account. The janitor frees both for closed PRs.

### If a preview credential leaks

Each preview branch gets its own `app_owner` password when it's created (ADR-0021), so a leaked connection string exposes that PR's branch only (synthetic data; production is a separate project with its own password).

1. Delete the leaking artifact (comment, log, file).
2. Revoke the PR's data: `FORCE=1 PR_NUMBER=<n> scripts/preview/infra.sh down` (deletes its Hyperdrive config and branch).
3. Re-run the PR's CI: a new branch, password and config are created.

Incident 2026-09-27 (PR #4): `up.sh`'s stdout was captured into the step output. The `::add-mask::` command was never executed, the preview connection string was posted in the PR comment, and the capture also **hid `up.sh`'s failure** (the step reported success). Fixed: the scripts write `$GITHUB_OUTPUT` themselves (`up.sh` is gone; `deploy-artifact.sh` and `infra.sh` keep the rule), and URL-shape guards run in the script and in the workflow. The leak was handled with the procedure of the time (delete, tear down, reset the seed's password).

## Observability (ADR-0015)

Where to look when production fails:

- **Dashboard:** Workers & Pages → `saas-foundation` → Observability (Logs / Events). Filter by `level = error`, by `event` (`server_fn.unhandled`, `health.db_down`, `better_auth`, `auth.captcha_unavailable`, `auth.turnstile_misconfigured`, `auth.turnstile_wrong_host`), or by `rayId`.
  - A user-reported Cloudflare ray id (shown on Cloudflare error pages) matches `rayId`.
  - Each request's invocation log shows its status and outcome.
- **Live:** `pnpm --filter app exec wrangler tail saas-foundation --format pretty --search '"level":"error"'`. Don't rely on `--status error`: it filters on the invocation's outcome, and server-function failures are turned into responses, so those invocations end `ok`.
- **Issues:** Workers & Pages → `saas-foundation` → Issues groups exceptions, `5xx` responses and error-level logs (ADR-0015).
- **Alerting (ADR-0031):** Issues automations post to the owner's private Slack channel: occurrence threshold 1 (each new issue once) and recurrence after 1 hour of inactivity. Destination `slack-saas-foundation-alerts` (Cloudflare Notifications webhook to a Slack incoming webhook). Tested end to end 2026-10-14: a new-issue alert within about a minute (ADR-0031 "Result"; channel privacy, app scopes and the recurrence automation owner-confirmed; recurrence not yet exercised). To re-test after changing it, run ADR-0031's test request.
  - On an alert: open the issue, find its `event` and `rayId` in Logs, and treat it as ongoing until resolved in Issues (a still-occurring issue doesn't alert again).
  - Don't forward alert content to other channels or tickets (it carries error messages and stack traces).
- **Health:** `curl -s https://<domain>/api/health` returns `{ ok, db, version, commit, build }` (ADR-0029: root `package.json` version, 7-character commit, CI build id or `local`). A `503` means the database is unreachable; the reason is in the `health.db_down` event.
- **Retention:** 7 days (Workers Paid). Copy anything needed longer into the incident notes, without PII.
- **Never** paste log lines containing user data into tickets or chat. The logger redacts emails and URL credentials; check anything you copy.

## CI credentials (ADR-0019, ADR-0021, ADR-0023)

No preview secret lives at repo level: a `pull_request` workflow runs the PR's own YAML and could read it. Every secret sits in an environment that only `main` may use, and only default-branch code (`workflow_run`, `pull_request_target`, schedule) uses it.

| Secret                                                                         | Where                                      | Scope                                                                                                                                                                                         | Used by                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `NEON_API_KEY`                                                                 | environment `production` (`main` only)     | Neon org key limited to the production project                                                                                                                                                | `db-backup.yml`, `release.yml` deploy, `rollback.yml`       |
| `CLOUDFLARE_API_TOKEN`                                                         | environment `production` (`main` only)     | account-owned token `saas-foundation`: Workers **Editor** on **Specified Workers → `saas-foundation`** only                                                                                   | `release.yml` deploy and promote, `rollback.yml`            |
| `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`, `R2_BACKUP_ENDPOINT` | environment `production` (`main` only)     | S3 credentials of account token `r2-dump-backups`: R2 **Object Read & Write** on bucket `saas-foundation-prod-db-dumps` only; the endpoint is `https://<account-id>.r2.cloudflarestorage.com` | `db-backup.yml` `dump`                                      |
| `HEALTHCHECKS_PING_URL`                                                        | environment `production` (`main` only)     | Healthchecks.io ping URL of check `saas-foundation-db-backup` (ADR-0037); it can only send pings                                                                                              | `db-backup.yml` `dump` (last step)                          |
| `CLOUDFLARE_PREVIEW_INFRA_TOKEN`                                               | environment `preview-infra` (`main` only)  | account-owned token: Account · **Hyperdrive · Edit** (API name `Hyperdrive Write`) only                                                                                                       | `preview.yml` infra, `preview-cleanup.yml` cleanup-infra    |
| `NEON_PREVIEW_API_KEY`                                                         | environments `preview-infra` and `preview` | Neon org key limited to the preview project                                                                                                                                                   | infra, deploy, cleanup-infra                                |
| `CLOUDFLARE_API_TOKEN`                                                         | environment `preview` (`main` only)        | account-owned token: Workers **Editor** on **Specified Workers → `saas-foundation-preview`** only                                                                                             | `preview.yml` deploy, `preview-cleanup.yml` cleanup-preview |
| `CLOUDFLARE_DOCS_TOKEN`                                                        | environment `docs` (`main` only)           | account-owned token: Workers **Editor** on **Specified Workers → `saas-foundation-docs`** only                                                                                                | `docs-deploy.yml`, `docs-rollback.yml`                      |
| `CLOUDFLARE_DOCS_PREVIEW_TOKEN`                                                | environment `docs-preview` (`main` only)   | account-owned token: Workers **Editor** on **Specified Workers → `saas-foundation-docs-preview`** only                                                                                        | `docs-preview.yml` deploy and cleanup                       |
| `CLOUDFLARE_SITE_TOKEN`                                                        | environment `site` (`main` only)           | account-owned token: Workers **Editor** on **Specified Workers → `saas-foundation-site`** only                                                                                                | `site-deploy.yml`, `site-rollback.yml`                      |
| `CLOUDFLARE_SITE_PREVIEW_TOKEN`                                                | environment `site-preview` (`main` only)   | account-owned token: Workers **Editor** on **Specified Workers → `saas-foundation-site-preview`** only                                                                                        | `site-preview.yml` deploy and cleanup                       |

Variables (not secret): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, the `NEON_*` ids; in `production`, `R2_BACKUP_BUCKET` (`saas-foundation-prod-db-dumps`).

- **Both Cloudflare tokens are sensitive.** The Hyperdrive token is account-wide (no per-config scope) and could edit production Hyperdrive; the Worker token can deploy a preview bound to any Hyperdrive id, production's included (binding needs no permission on the bound resource). The scripts' guards (ADR-0021 decision 3) and the environments are the fence. No job holds both.
- **Cloudflare account token `saas-foundation`** (2026-09-30): Workers Editor on the production Worker `saas-foundation` only. Stored by the owner on 2026-09-30 06:52Z as `CLOUDFLARE_API_TOKEN` in environment `production`. ADR-0029 wires it into `release.yml` and `rollback.yml` (steps that use it get no Neon key; `snapshot` and `dump` don't receive it). It can upload and deploy versions of the production Worker, bound to production Hyperdrive by design, so it is a production-data credential.
- **Current state (2026-09-29):** all of the above are in place; the repository holds no secrets. Neon organization keys: `saas-foundation-preview-ci` (preview project, both preview environments) and `saas-foundation` (production project, `production`; used by `db-backup.yml`, **keep**).
- **Rotating or recreating preview credentials (owner):**
  1. Cloudflare dashboard → Manage Account → Account API Tokens → _Create token_ → _Custom token_: name `saas-foundation-preview-infra`; permissions **Account · Hyperdrive · Edit**, nothing else; account resources: this account only; no zone permissions, no IP filter. `gh secret set CLOUDFLARE_PREVIEW_INFRA_TOKEN --env preview-infra`.
  2. Neon console → Organization settings → API keys → _Create key_ → _Project-scoped_, project = the preview project, name `saas-foundation-preview-ci`. `gh secret set NEON_PREVIEW_API_KEY --env preview-infra` and `gh secret set NEON_PREVIEW_API_KEY --env preview` (same value).
  3. The per-Worker token (ADR-0019): `gh secret set CLOUDFLARE_API_TOKEN --env preview` (its value, or roll it in the dashboard to get a new one).
  4. Run a PR preview through `preview.yml` / `preview-cleanup.yml`, then revoke the replaced key or token. Never put a preview secret at repo level.
- **R2 dump token `r2-dump-backups`** (2026-09-30, ADR-0023): it can read every dump in plain text (R2 has no write-only permission, and the dumps rely on R2's managed encryption only), so treat it as a production-data credential. Rotate: Cloudflare dashboard → R2 → Manage API tokens → create an **Account** token with **Object Read & Write**, applied to **specific buckets → `saas-foundation-prod-db-dumps`** only; in your own terminal, `gh secret set R2_BACKUP_ACCESS_KEY_ID --env production` and `gh secret set R2_BACKUP_SECRET_ACCESS_KEY --env production` (hidden prompt); discard the token's bearer value; run `gh workflow run db-backup.yml` and check the `dump` job; then delete the old token.
- **Production Neon key:** `saas-foundation`, in `production` as `NEON_API_KEY`; `db-backup.yml` read it successfully on 2026-09-29. It is the only production key; don't revoke it. (If production moves to its own Neon organization, ADR-0026 option 3, replace it first as that ADR describes.) Production deploys run from the owner's machine (runbook "First production deploy").

## Email (ADR-0016, ADR-0024)

Sender `SaaS Foundation <no-reply@mail.aaronlabr.dev>` through Cloudflare Email Service (`send_email` binding `EMAIL`). Delivery is off until both production secrets are set; previews never get the binding.

1. **Owner, once:** in your own terminal, `pnpm --filter app exec wrangler secret put EMAIL_FROM` (value `no-reply@mail.aaronlabr.dev`), then `pnpm --filter app exec wrangler secret put EMAIL_DELIVERY` (value `cloudflare`). `wrangler secret list` shows both names. The binding must already be deployed (`pnpm run deploy` from a clean checkout of `main`, runbook "First production deploy" step 0), or the first send logs `email.misconfigured`.
2. **Smoke test** (only addresses you control): request a password reset for a smoke-test account, and invite another of your addresses to a smoke-test organization. Both emails arrive from the sender above; in the message source, `Authentication-Results` shows `spf=pass` and `dkim=pass`. A failure logs `email.send_failed` or `email.misconfigured` (Observability).
   - _Done 2026-10-01 (UTC; owner, Gmail, production version `06c26a5d` with the `EMAIL` binding restricted to the sender and both secrets set): **password reset** to a smoke-test address arrived from `SaaS Foundation <no-reply@mail.aaronlabr.dev>`, subject "Reset your password", link `/reset-password?token=…` (token in the query string); Gmail's header summary showed mailed-by `cf-bounce.mail.aaronlabr.dev` and signed-by `mail.aaronlabr.dev`; the reset completed and signed other sessions out. **Verification** on sign-up of a third smoke-test plus-address (added to `SIGNUP_ALLOWLIST`) arrived from the same sender, subject "Verify your email address", link `/api/auth/verify-email?token=…`; the link verified and led to "New organization" (verification isn't required yet, ADR-0016). **Invitation** from a smoke-test organization to that address arrived from the same sender, link `/invite/<id>`, the same link the inviter was shown. **Authentication** (`Authentication-Results` from mx.google.com in each downloaded `.eml`, header lines only): all three emails (reset 00:12:52Z, verification 00:17:47Z, invitation 00:21:28Z) show `spf=pass` (`smtp.mailfrom=bounces@cf-bounce.mail.aaronlabr.dev`, IP `104.30.16.68`), `dkim=pass` for `header.i=@mail.aaronlabr.dev` (selector `cf-bounce`) and for `@cloudflare-smtp.net`, and `dmarc=pass` (`p=REJECT`). All three landed in the inbox (owner). Step 2 complete._
3. **Turn it off:** `pnpm --filter app exec wrangler secret delete EMAIL_DELIVERY` (creates a new Worker version; no code deploy); sends are then skipped with `email.delivery_disabled`.
4. **Change the sender:** `wrangler.jsonc` `allowed_sender_addresses` and the constant in `scripts/preview/prepare-config.mjs` in one PR, then update `EMAIL_FROM`.
5. **Email verification rollout** (ADR-0016, once, after deploying the release that enforces it): sign-in now needs a verified address, but sessions created before stay valid. In the Neon console (production project → SQL Editor, branch `main`, database `app`):
   - Count first: `SELECT count(*) FILTER (WHERE NOT u.email_verified) AS unverified_users, count(s.id) FILTER (WHERE NOT u.email_verified) AS their_sessions FROM "user" u LEFT JOIN session s ON s.user_id = u.id;`
   - Then revoke those sessions: `DELETE FROM session WHERE user_id IN (SELECT id FROM "user" WHERE NOT email_verified);` (deletes exactly `their_sessions` rows). Their next sign-in is refused and sends a fresh link.
   - Check: a verified smoke-test account signs in as before; an unverified one gets "Verify your email address first. We sent you a new link.", the link arrives, and after following it, sign-in works.
   - _Done 2026-10-01 (UTC; owner, production version `d23847d9` deployed from `main` at #56, 02:07:53Z): count before revoking: 2 unverified users holding 1 session; the `DELETE` ran (the SQL Editor showed no row count); afterwards the count of sessions belonging to unverified users was 0. A verified smoke-test account signed in as before. A fourth smoke-test plus-address (allowlisted) signed up and got "Check your email"; its verification email arrived at 02:12:39Z (`From: SaaS Foundation <no-reply@mail.aaronlabr.dev>` in the downloaded `.eml`), `Authentication-Results` (header lines only) `spf=pass`, `dkim=pass` (`@mail.aaronlabr.dev` and `@cloudflare-smtp.net`), `dmarc=pass`; the link was `/api/auth/verify-email?token=…&callbackURL=/login?verified=1&redirect=/` (URL-encoded). Signing in before following it showed "Verify your email address first. We sent you a new link."; that second email arrived at 02:34:42Z (downloaded `.eml`: same `From`, `spf=pass`, `dkim=pass`, `dmarc=pass`, link `/api/auth/verify-email?token=…&callbackURL=/`, as a sign-in resend lands on `/`). After following that resent (02:34:42Z) link (owner) and signing in, the account reached "New organization" (whether the "Email verified" notice showed wasn't reported). Step 5 complete._

## Turnstile (ADR-0025)

Bot check on sign-up, sign-in, password-reset requests and verification-email requests. Without both keys those endpoints answer 503 (`auth.turnstile_misconfigured`), and `pnpm run deploy` refuses to deploy, so set the secrets **before** deploying the release that adds Turnstile.

1. **Owner, once:** Cloudflare dashboard (production account) → Turnstile → Add widget: hostname `app.aaronlabr.dev` only, widget mode **Managed**, no pre-clearance. Copy the site key and the secret key.
   - _Done 2026-10-01 (owner, dashboard): widget "aaronlabr.dev (Spin)", site key `0x4AAAAAAFK2wdwArRcfOo_0` (public), mode Managed, no pre-clearance, hostnames `aaronlabr.dev`, `localhost`, `127.0.0.1` (not `app.aaronlabr.dev` alone as above; production still accepts only tokens reporting `app.aaronlabr.dev`)._
2. **Owner:** in your own terminal, `pnpm --filter app exec wrangler secret put TURNSTILE_SITE_KEY`, then `pnpm --filter app exec wrangler secret put TURNSTILE_SECRET_KEY` (values at the hidden prompt). `wrangler secret list` shows both names. Each `secret put` creates a Worker version of the deployed code, which ignores them until the deploy.
   - _Done 2026-10-01 (owner): `wrangler secret list` shows `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY`._
3. **Deploy:** `pnpm run deploy` from a clean checkout of `main` (runbook "First production deploy" step 0).
   - _Done 2026-10-01 (owner, `main` with #59 and #60): version `8cc26dea-c694-4290-a7e8-835fa777c18d` at 100%, created 07:30:51Z (`wrangler deployments list`)._
4. **Browser check** (a smoke-test account): `/login` shows the Turnstile widget and the Sign in button turns on after it passes; signing in works; in DevTools → Network the `sign-in/email` request carries an `x-captcha-response` header and no URL holds a token. `/forgot-password` and `/signup` show the widget too. Logs show no `auth.turnstile_misconfigured`.
   - _Done 2026-10-01 (owner, Chrome, a smoke-test account): `/login`, `/signup` and `/forgot-password` show the widget (automatic check, and a challenge when shown); sign-in `POST /api/auth/sign-in/email` at 07:42:54Z answered 200 with an `x-captcha-response` request header, page URL `/login?redirect=%2F` (no token). With real keys that 200 means siteverify accepted the token for `app.aaronlabr.dev` and the `login` action. **Replay** of a fresh sign-in's request, within minutes: DevTools "Replay XHR" answered 403; a `curl` carrying the same token answered `{"code":"VERIFICATION_FAILED"}` (status not captured). Both refused the token; whether as already spent or as expired wasn't observed. Workers Logs since 07:30Z: `auth.turnstile_misconfigured`, `auth.turnstile_wrong_host`, `auth.captcha_unavailable` 0 each. Not checked in production: a request without a token (400 `MISSING_RESPONSE`; covered by `test/turnstile.test.ts`). The session whose cookie was shared during the check was signed out. Step 4 complete._
5. **If sign-in answers 503** "Sign-in is temporarily unavailable": a key is missing or a Cloudflare test key reached production (`auth.turnstile_misconfigured`, `reason`), or test keys meant for a preview or localhost URL are being reached on another host (`auth.turnstile_wrong_host`: check `BETTER_AUTH_URL`). Fix the secret; no deploy needed. A 500 with `auth.captcha_unavailable` means siteverify was unreachable (Cloudflare side); a 403 means the token was rejected (expired, reused, or issued for another hostname).
6. **Rotate the secret:** Turnstile → the widget → rotate the secret key, then `wrangler secret put TURNSTILE_SECRET_KEY` with the new value.

Local dev, CI and previews use Cloudflare's public always-pass test keys: `apps/app/.dev.vars` needs `TURNSTILE_SITE_KEY=1x00000000000000000000AA` and `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` (the app refuses test keys outside localhost and workers.dev).

## Polar (ADR-0022, ADR-0018, ADR-0020)

Polar is the billing provider and merchant of record: it computes, collects and remits sales tax/VAT and pays the owner out. Unless `BILLING_PROVIDER=polar`, billing actions and the webhook answer 503 (local dev; previews never get a Polar secret, ADR-0021). The production Worker has run against the Polar **sandbox** since 2026-09-30 (steps 2–7 below; smoke-test organizations only). Before switching it to `POLAR_SERVER=production`: the Neon upgrade (ADR-0026 trigger 1), a recorded plan for pilot organizations' sandbox subscriptions and customer links (ADR-0032 decision 4; pilot organizations hold real data and aren't deleted), and delete the smoke-test organizations while still in sandbox mode (they hold sandbox customers, and owner changes must keep reaching Polar). An organization with a live subscription can't be deleted (`isLive` in `policy.ts`), so first cancel each subscription and wait until it is `canceled` and its Billing page shows Free. Set everything up in the **sandbox** first (`POLAR_SERVER=sandbox`), pass the pre-go-live checks below, then repeat steps 1–6 in production (`POLAR_SERVER=production`).

1. Polar organization. Production only: the payout account, in the owner's country of residence.
2. Products: one per sellable price, fixed price (not seat-based), recurring: "Pro monthly" (monthly) and "Pro yearly" (yearly), each with metadata `price_key` = `pro_monthly` / `pro_yearly`, matching `PLANS` in `apps/app/src/modules/billing/policy.ts`. Amounts and currency live only in Polar. Keep exactly one non-archived product per `price_key`; retire a price by archiving its product and marking it `retired` in `policy.ts`. Create no other recurring product (not even a free one): the portal offered the sandbox's `Free (eval)` product as a plan change alongside the Pro ones (2026-09-30), and a `price_key` the policy doesn't know maps to no plan (Free) while Polar keeps the subscription.
3. Customer portal settings: enable subscription plan changes (switching between the two Pro products). Polar's portal can't be disabled; on 2026-09-30 the owner found no cancellation setting among its settings, and cancelling in the portal worked (checks below).
4. Organization access token with only the scopes the adapter uses: `customers:write`, `members:write`, `products:read`, `checkouts:write`, `customer_sessions:write`, `subscriptions:read`. A missing scope shows up in step 7 as a Polar permission error.
5. Webhook endpoint (dashboard: Settings → Webhooks) `https://<hostname>/api/billing/webhooks/polar`, raw JSON format, every `subscription.*` event (each delivery re-reads the subscription from Polar, so extra ones are harmless; other types are recorded and ignored). Its signing secret becomes `POLAR_WEBHOOK_SECRET`. Polar disables an endpoint whose deliveries keep failing (sandbox, 2026-09-30: the eval endpoints, which can't be reached, were found disabled), and a disabled endpoint receives nothing more; after any outage of the webhook route, check in the dashboard that the endpoint is still enabled, look in its delivery log for deliveries that failed during the outage, and check that each affected organization's Billing page matches its subscription in Polar, and re-sync any that doesn't ("Re-sync one subscription from Polar" below).
6. Worker secrets (owner), `pnpm --filter app exec wrangler secret put <NAME>` for each: `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_SERVER` (`sandbox` or `production`; unset = sandbox), then `BILLING_PROVIDER` (`polar`) last. Enter the token and the webhook secret at wrangler's hidden prompt in the owner's own terminal, so neither reaches a chat, a log or the shell history.
   - In Polar mode without the token, billing actions and subscription webhooks answer 503, and owner removals, demotions and organization deletion are refused (fail closed); without the webhook secret the webhook answers 503.
   - Don't unset `BILLING_PROVIDER` once organizations have Polar customers: owner changes would stop reaching Polar.
7. Check it: as the owner, Billing → Upgrade → the checkout should start at your own country (the app forwards Cloudflare's `cf-connecting-ip`; local dev sends `127.0.0.1`, so none there) → test card (sandbox) → back on Billing, the plan shows Pro once the webhook has arrived; Manage billing opens the Polar portal showing only this organization's subscription.
   - _Done 2026-09-30 (sandbox, production Worker; owner): steps 2–6 (`Free (eval)` archived, leaving one active product per `price_key`; a new token; endpoint enabled, raw, all 11 `subscription.*` events), then step 7 on a smoke-test organization: the checkout page opened with Peru selected, which the owner kept (Polar API: created with country `PE`); Billing showed Pro (trialing) once `subscription.created`, `.active` and `.updated` had been delivered (each HTTP 200); the portal showed only that subscription. On a second smoke-test organization the first return to Billing still showed Free, and a reload showed Pro (trialing)._

The adapter itself can also be exercised against the sandbox with `apps/app/eval/polar-provider.test.ts` (not part of `pnpm test`; see its header).

### Re-sync one subscription from Polar

When an organization's Billing page disagrees with its subscription in Polar: after a webhook outage (step 5), after a database restore or reconcile ("Database"; billing tables are never copied from a snapshot), or when a tenant reports it. The app only changes billing state from a verified webhook, and each subscription event makes it re-read the subscription from Polar and apply its current state (ADR-0018, ADR-0022). So a re-sync means getting Polar to send one **new** event. Don't edit `billing_subscription` or `billing_webhook_event` by hand.

_Not drilled yet: the first use (sandbox first) records here whether a metadata-only update sends `subscription.updated` and what the delivery answered._

1. **Find the subscription:** the organization's id (Neon SQL Editor: `select id from organization where slug = '<slug>'`), then `select provider_subscription_id, status, plan_key, provider_event_at from billing_subscription where organization_id = '<org id>'`. With no row, or to check for a newer subscription, find the customer in the Polar dashboard by external id = the organization id and take its subscription.
2. **A delivery that failed** (never answered 2xx, e.g. during an outage): redeliver it from the endpoint's delivery log in the Polar dashboard, then read its answer (step 4). A redelivery keeps its `webhook-id` and its original event time: it answers `duplicate` if the app had already recorded it (also possible when the app committed but its response was lost), and `stale` if a newer event for the subscription was applied since. Either way nothing changes; if the mismatch remains, use step 3.
3. **Make Polar send a new event**, from the owner's own terminal with a temporary organization access token holding `subscriptions:read` and `subscriptions:write` (the app's token is read-only for subscriptions; delete this one afterwards). Enter it at a hidden prompt so it stays out of the shell history, and pass it to curl on stdin so it stays out of process listings:

   ```sh
   read -rs POLAR_TOKEN && export POLAR_TOKEN
   API=https://sandbox-api.polar.sh/v1   # POLAR_SERVER=production: https://api.polar.sh/v1
   SUB=<subscription id>
   polar() { printf 'Authorization: Bearer %s\n' "$POLAR_TOKEN" | curl -fsS -H @- "$@"; }
   polar "$API/subscriptions/$SUB" |
     jq '{status, cancel_at_period_end, current_period_end, metadata, external_id: .customer.external_id}'
   ```

   `metadata.organization_id` and `external_id` must both equal the organization's id; otherwise the app records the subscription as unlinked and never applies it (ADR-0022), and a re-sync won't change that. Then send the subscription's metadata back with one key added (Polar's docs don't say whether metadata is merged or replaced, so the whole set goes back):

   ```sh
   meta="$(polar "$API/subscriptions/$SUB" |
     jq -c '.metadata + {resync_at: (now | todate)}')"
   polar -X PATCH -H 'Content-Type: application/json' \
     "$API/subscriptions/$SUB" -d "{\"metadata\": $meta}" | jq '{status, metadata}'
   unset POLAR_TOKEN
   ```

   `resync_at` stays on the subscription; the app ignores it, and the next re-sync overwrites it. If Polar refuses the update (for example on a subscription that has ended), record the mismatch here and leave the row as it is.

4. **Check:** the endpoint's delivery log shows the new `subscription.updated` answered 200 with `"outcome":"applied"`, and the organization's Billing page now matches Polar (plan, status, renewal or end date). Other outcomes: `stale` (an older event: for the same subscription, one applied since is newer; or the organization's row holds another subscription, and this one has ended or the other one's last event is newer; kept on purpose), `unlinked` (step 3's ids disagree), `conflict` (the subscription is linked to another organization), `duplicate` (already recorded; a redelivery, step 2). Record the date, the organization, what was wrong and the outcome here.

### Before production go-live (sandbox checks, ADR-0022 step 3)

Each check must pass in the sandbox, through a checkout opened by the app, and be recorded here (date and what was observed) in a PR before production is switched to Polar. Webhook deliveries need the endpoint reachable from Polar; Polar's delivery log shows each event.

- [x] **Billing country:** the checkout starts with no country or the buyer's, never an unrelated default; the country the buyer picks is what Polar stores (customer billing address) and what the invoice shows. 2026-09-29 (sandbox): checkouts opened by the app without the buyer's IP started with no country; the app now forwards Cloudflare's `cf-connecting-ip` as `customer_ip_address`, and checkouts opened through the adapter (sandbox eval, IP supplied by the harness) with a Peruvian IP started prefilled `PE` (direct API probes: `8.8.8.8` → `US`, `127.0.0.1` → none, accepted). Kept as prefilled, the paid order stored `PE`; changed to Chile on Polar's page, the paid order stored `CL` and the invoice billed to Chile. The eval runs' earlier `AO`, `AR` and `PE` were likewise the buyer's deliberate picks, each stored and invoiced as picked. 2026-09-30 through the deployed app (step 7): the checkout the app opened at 05:48:21Z carried the buyer's IP and opened with Peru, the buyer's country, selected (owner; Polar API: created with `PE`); the owner kept it, and Polar stored the customer's billing address as `PE`.
- [x] **Plan change:** switching `pro_monthly` ↔ `pro_yearly` in the portal produces `subscription.updated` events that link to the organization and map to the new `price_key`, with Polar's proration. 2026-09-30 (sandbox, eval run `r11-0929`, adapter checkout, trial ended early with `POLAR_EVAL_PAID=endtrial`, then charged $29 as `active`): switching in the portal from `pro_monthly` to `pro_yearly` ($290/year) sent `subscription.updated` carrying `pro_yearly`, linked, re-read as `active`/`pro_yearly` with the period end moved a year out; Two earlier switches, through a mistaken `pro_yearly` product with a monthly interval (since archived) and back to `pro_monthly`, each sent a linked `subscription.updated` with the new `price_key` and made no order of their own. Polar then charged at once one `subscription_update` order of $261.02 with proration lines for all three switches: +$290.00 (the year), −$28.99 and +$28.99 and −$28.99 (monthly time), +$289.92 and −$289.91 (the mistaken product). Switching back from `pro_yearly` to `pro_monthly` sent `subscription.updated` carrying `pro_monthly`, linked, re-read as `active`/`pro_monthly` with a monthly period from the switch, and Polar recorded a `subscription_update` order of −$260.99 (−$289.99 for the unused year, +$29.00 for the month). 2026-09-30 through the deployed app (the step 7 subscription, its trial ended early by moving `trial_end` through the API, then charged $29.00 and `active`): switching in the portal to `pro_yearly` sent `subscription.updated` carrying `pro_yearly` (delivered, HTTP 200) and made a `subscription_update` order of +$261.00 (+$290.00 for the year, −$29.00 for the remaining month); the app's Billing page then showed renewal on 2027-09-30. Switching back sent `subscription.updated` carrying `pro_monthly` (HTTP 200) and an order of −$261.00, with a monthly period from the switch; Billing showed renewal on 2026-10-30. Both events linked (`metadata.organization_id` equal to the customer's `external_id`).
- [ ] **Failed renewal:** a subscription whose renewal is charged to a failing test card goes `past_due` (plan kept, ADR-0020) and then `unpaid` or `canceled` (Free), each event linked and applied. 2026-09-30 (sandbox, eval run `r13-0929`, adapter checkout paid with Stripe's `4000 0000 0000 0341`, which Polar's checkout accepted): trial end moved to 02:49:46Z (`POLAR_EVAL_PAID=endtrial`); the charge failed and Polar sent `subscription.updated` (sent as `active`), then `subscription.updated` and `subscription.past_due` (sent as `past_due`); every event linked and, re-read by the parser, mapped to `past_due` (plan kept, `ENTITLED` in `policy.ts`), next period end 2026-10-30. Remaining: the end of Polar's retries (2, 7, 14 and 21 days after the failure, then canceled; sooner on a permanent decline), expected around 2026-10-21 (`POLAR_EVAL_PAID=events` on `r13-0929`; if Polar has disabled its endpoint by then, see step 5, the subscription's state shows the outcome but not the events); and the same for the deployed app's subscription below: each event delivered and the Billing page showing Free; then tick this. 2026-09-30 through the deployed app (a second smoke-test organization, checkout paid with `4000 0000 0000 0341`, trial end moved to 06:19:29Z through the API): the charge failed; Polar sent `subscription.cycled` and `subscription.updated` (as `active`), then `subscription.updated` and `subscription.past_due` (as `past_due`), each delivered (HTTP 200) and linked; Billing showed Pro (past due) with Pro limits, and the portal showed the $29 order as pending.
- [x] **Cancellation at period end:** cancelling in the portal keeps `active` with `cancel_at_period_end` until the period ends, then Free. 2026-09-30 (sandbox, eval run `r12-0929`, trialing adapter checkout): cancelling in the portal at 02:43Z sent `subscription.updated` and `subscription.canceled` right away, both sent and re-read as `trialing` with `cancel_at_period_end: true` (plan kept); `subscription.canceled` doesn't mean the plan ended, and the parser applies the re-read status, not the event type. With the period end brought forward to 02:54:05Z (`POLAR_EVAL_PAID=endtrial`), Polar sent `subscription.updated`, `subscription.canceled` and `subscription.revoked`, sent and re-read as `canceled` (Free). Every event linked to the organization (`POLAR_EVAL_PAID=events`). This was a trialing subscription; 2026-09-30 through the deployed app (the plan-change subscription above, `active`, paid): cancelling in the portal at 06:12:25Z sent `subscription.updated` and `subscription.canceled`, both `active` with `cancel_at_period_end: true`, delivered (HTTP 200) and linked; Billing showed Pro (active), ending on 2026-10-30, and the portal "To be cancelled". Done 2026-10-14 (sandbox, deployed app; owner and Claude): to run the step now rather than on 2026-10-30, that subscription's period end was brought forward to 15:51:29Z through the API (`PATCH /v1/subscriptions/{id}` with `current_billing_period_end`; `ends_at` moved with it, still `active` with `cancel_at_period_end: true`). At 15:51Z Polar sent `subscription.updated`, `subscription.canceled` and `subscription.revoked`, each delivered (HTTP 200); Polar's API then showed `canceled`, `ended_at` 15:51:29Z; Billing showed "Plan: Free (canceled)" with the Free limits (projects 1 of 3, members 1 of 3).

## Recovery card (ADR-0036)

Start here in an incident. Pick the row, run the linked steps, then record what happened (date, cause, steps, times) under the section used. Execution targets are ADR-0036's; the owner's response is best effort.

|     | Scenario                             | Do                                                                                                              | Section                                                     | Drilled execution time                                               |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| A   | Bad release, code only               | Roll back the Worker (workflow, or the manual fallback if Actions is down)                                      | "Rollback"                                                  | 50–70 s from dispatch (app, 2026-10-15)                              |
| B   | Data damaged, noticed **within 6 h** | Point-in-time restore of `main` to just before the damage; or selective recovery from a point inside the window | "Database" first item; "Reconcile" under selective recovery | CLI 2–6 s (throwaway projects)                                       |
| C   | Data damaged, noticed **later**      | Selective recovery from the newest snapshot (preferred), or promote it (last resort; loses later writes)        | "Database" → "Restore from a daily snapshot"                | selective 9–11 s, promote renames 2–3 s, plus the Hyperdrive repoint |
| D   | Neon project or account lost         | Rebuild from the newest R2 dump into a new project, repoint Hyperdrive                                          | "Database" → "Restore from an off-provider dump", step 5    | 59 s to a healthy Worker (disposable, 2026-10-15)                    |

Pre-filled (production): Worker `saas-foundation`, host `app.aaronlabr.dev`; Neon project `flat-cherry-23373668`, database `app`, role `app_owner`; Hyperdrive `saas-foundation-prod` (`DB` id in `apps/app/wrangler.jsonc`); dumps in R2 bucket `saas-foundation-prod-db-dumps` (`daily/`); backup heartbeat check `saas-foundation-db-backup` (Healthchecks.io).

Credentials for a recovery by hand (all the owner's own logins, nothing from CI): `wrangler login` (Worker rollback, Hyperdrive update and restart; `wrangler auth token` gives `CLOUDFLARE_API_TOKEN` for the scripts), `neon auth` (branches, restore; `NEON_API_KEY` from `~/.config/neon/credentials.json` as in "Previews" → "By hand"), `gh auth login` (workflows), the Cloudflare dashboard (R2 download), the Neon console (SQL Editor).

When GitHub Actions is unavailable (as from 2026-10-15 until the November reset), every row still works by hand: A with the manual fallback in "Rollback"; B–D need no workflow.

## Database (ADR-0003, Neon Free)

- Restore within 6 h: Neon point-in-time restore of `main`: `neon branches restore main "^self@<UTC timestamp>" --preserve-under-name main-before-pitr-YYYYMMDD --project-id "$NEON_PROJECT_ID"`. `main` keeps its connection string, so Hyperdrive needs no change. _Drilled 2026-10-15 on throwaway projects with a snapshot child present: the CLI call took 2–6 s and brought back the old data. Afterwards the preserved branch was a root in one run and the parent of `main` and of the snapshot in the other; with children it can't be deleted, so like a promote it can permanently use a branch slot._
- Restore from a daily snapshot (ADR-0003 option A; `backup-YYYYMMDD`, newest 3 kept). Snapshots are **child branches** of `main`, and Neon's `branches restore` only works between root branches, so **don't use `neon branches restore`**. History: first tried on the preview project when this procedure was written; the snapshot → read-only check → writable branch drill ran on the production project on 2026-09-28 (below; ADR-0019); selective copy and promote were drilled on throwaway projects on 2026-10-15. Auth: `neon auth` (or `NEON_API_KEY`); set `export NEON_PROJECT_ID=flat-cherry-23373668` and pass `--project-id "$NEON_PROJECT_ID"` to every command.
  1. **Inspect:** `neon branches add-compute backup-YYYYMMDD --type read_only --project-id "$NEON_PROJECT_ID"`, then `neon connection-string backup-YYYYMMDD --project-id "$NEON_PROJECT_ID"` and query it (e.g. `docker run --rm postgres:17-alpine psql "<url>"`).
  2. **Selective recovery** (preferred; keeps newer writes): `docker run --rm postgres:17-alpine pg_dump "<backup url>" --data-only --table=<t>` piped into `psql "<main url>"` copies a table whose rows are all missing from `main`. Anything else needs the reconcile steps. _Drilled 2026-10-15 on throwaway projects: 9–11 s for a one-row table; the damaged row came back and a valid write made after the snapshot was kept._
     **Reconcile** (not drilled beyond that one-row case):
     1. **Scope:** the tables, organizations and time window the damage touched (release time, logs, the reporting tenant). Write it down first.
     2. **Copy both sides out**, scoped, into staging tables in a local container (`docker run -d --name reconcile -e POSTGRES_PASSWORD=x postgres:17-alpine`, database `scratch`). For each affected table `<t>`:
        - `\copy (select * from <t> where organization_id = '<org>' …) to '<t>.src.csv' csv header` against the source (snapshot or point-in-time branch), and the same query to `<t>.cur.csv` against `main` (`psql "<url>" -c …`; a table without `organization_id` is scoped by its join to one);
        - in `scratch`: `pg_dump --schema-only --table=public.<t> "<main url>"` loaded, `alter table <t> rename to cur_<t>`, `create table src_<t> (like cur_<t>)`, then `\copy cur_<t> from '<t>.cur.csv' csv header` and `\copy src_<t> from '<t>.src.csv' csv header`.
     3. **Classify by primary key** (joins of `src_<t>` and `cur_<t>`): in `src` only → re-insert **only** with evidence the damage deleted it (inside the window, per logs or the incident's cause); a row deleted legitimately since the source would otherwise come back, so unexplained ones are decided by hand. In both and different → restore the `src` values if the damage changed the row; if a user changed it afterwards, decide by hand. In `cur` only → created after the source: keep, unless the damage created it.
     4. **Apply** to `main` in one transaction (`begin; … commit;` in `psql`), parents before children (`organization`, `user` → `member`, `invitation`, `project`), every statement filtered to the organizations in scope.
     5. **Billing is never copied from a snapshot:** `billing_subscription` would bring back old entitlements, and `billing_webhook_event` is the global dedupe table. Billing state comes only from Polar's current state through the verified webhook path (ADR-0022: the handler re-reads the subscription from Polar on every subscription event). After the apply, check each organization in scope against Polar and re-sync any mismatch ("Polar" → "Re-sync one subscription from Polar").
     6. **Verify:** counts of the scoped rows match the plan from step 3; `/api/health`; the affected tenant's pages. Then `docker rm -f reconcile` and delete the CSVs (customer data).
  3. **Full rollback ("promote"; loses writes made after the snapshot):**
     - `neon branches add-compute backup-YYYYMMDD --type read_write --project-id "$NEON_PROJECT_ID"`
     - `neon branches rename main main-before-restore-YYYYMMDD --project-id "$NEON_PROJECT_ID"`, then `neon branches rename backup-YYYYMMDD main --project-id "$NEON_PROJECT_ID"`, then `neon branches set-default main --project-id "$NEON_PROJECT_ID"`
     - **Point Hyperdrive at the promoted `main` and restart its pool**, with the helpers from "Runtime role (ADR-0038)" → Session setup (no credential in argv): `owner_env main $P_PROD && hd_point app_owner`. Once production runs as `app_runtime` (that section's gates done), give the promoted branch's `app_runtime` a new password (its step 1.2) and run `hd_point app_runtime` instead. Caching stays disabled; the id and binding are unchanged, so no redeploy. The restart matters because an update doesn't close existing pooled connections, which would keep using the old branch. Dashboard alternative for the restart: Hyperdrive → `saas-foundation-prod` → Settings → Danger zone → **Restart**. In-flight queries may briefly error.
     - _Drilled 2026-10-15 (throwaway projects; no Hyperdrive): the renames and `set-default` took 2–3 s. Point-in-time restore on the promoted `main` worked for a time 2 min after the promotion; a time before the snapshot branch was created was refused ("historical data is not available"). Times between the snapshot's creation and the promotion are untested. In a separate drill (step 5 below), traffic followed a `hyperdrive update` without the restart; keep the restart step, since that was one test with a nearly idle pool._
     - verify `/api/health`. The promoted copy holds the snapshot's billing state: check every organization with a subscription against Polar and re-sync any mismatch ("Polar" → "Re-sync one subscription from Polar"; deliveries made since the snapshot aren't recorded in it, so redelivering them also works). `main-before-restore-*` **can't be deleted**: it's the parent of the new `main` and of the older snapshots, and Neon forbids deleting branches that have children. Each promote therefore permanently uses one of the 10 branch slots, so treat promote as a last resort and prefer selective recovery. Snapshots keep working because the new production branch is named `main` again.
- Neon's snapshot feature (one-step restore that keeps the connection string) is limited on Free to **1 manual snapshot, no schedules**. Registered as a possible complement, not adopted.
- Snapshots and dumps run daily (`db-backup.yml`, jobs `snapshot` and `dump`); `gh workflow run db-backup.yml` runs both by hand. **A run on a UTC day that already has its copies makes none** (`snapshot.sh` keeps `backup-YYYYMMDD`, `dump.sh` skips a day whose `.sha256` exists), so it isn't a way to get a fresh copy before a risky change: for that, take a Neon branch of `main` without compute, as `scripts/release/restore-point.sh` does (`neon branches create --name pre-change-YYYYMMDDTHHMMSSZ --parent main --no-compute --project-id "$NEON_PROJECT_ID"`), and delete it when done (it counts toward the 10 branches).
- **Backup heartbeat** (ADR-0037): the `dump` job's last step pings Healthchecks.io check `saas-foundation-db-backup` (period 1 day, grace 8 h; alerts by email): `/fail` when the snapshot or the dump failed, success only when both succeeded and a new copy was uploaded, nothing when a same-day re-run made no new copy. No success ping for 32 h also alerts.
  - **Setup (owner):** create the check with those settings and enable the email integration on it; then `gh secret set HEALTHCHECKS_PING_URL --env production` with its `https://hc-ping.com/<uuid>` URL (prompted, so it stays out of shell history). Without the secret the step fails the job. _Done 2026-10-15 (owner): check created with email alerts, no Slack; secret set (`gh secret list --env production` lists it)._
  - **Rollout check (owner), before relying on it:** the check stays "new" and can't alert until its first ping. After the first scheduled run that uploads a new dump, the check must show "up" with one success ping. Then test delivery: `curl -fsS https://hc-ping.com/<uuid>/fail` (the alert email must arrive), then `curl -fsS https://hc-ping.com/<uuid>` to return it to "up" (that day's copy exists). Record the date here.
  - **On a "down" or failure alert:** `gh run list --workflow db-backup.yml -L5`. A run stuck in `queued`/`waiting` (as on 2026-10-02): cancel it, then `gh workflow run db-backup.yml`. A failed job: read its log and fix, then dispatch. A run that never started: dispatch. The alert clears with the next success ping, which needs a new copy: a run on a UTC day that already has a complete dump makes none and sends no ping.
  - **Compromised ping URL:** a check's UUID can't be changed. Create a replacement check with the same settings and email integration, `gh secret set HEALTHCHECKS_PING_URL --env production` with its URL, confirm it becomes "up" after the next new dump, then delete the old check.
- **Restore from an off-provider dump** (ADR-0023, option B; survives a Neon outage or the loss of the project). The `dump` job writes `daily/app-YYYYMMDD.dump` (custom format) and `daily/app-YYYYMMDD.dump.sha256` to R2 bucket `saas-foundation-prod-db-dumps`; a lifecycle rule deletes them after 30 days. The dumps aren't client-side encrypted: handle a downloaded dump as customer data and delete it when done.
  1. **Download** the dump and its `.sha256` (Cloudflare dashboard → R2 → `saas-foundation-prod-db-dumps` → `daily/` → the object → Download) into one directory; the dashboard saves them as `daily_app-YYYYMMDD.dump[.sha256]`; rename both to `app-YYYYMMDD.dump[.sha256]` (the name inside the `.sha256`), then `sha256sum -c app-YYYYMMDD.dump.sha256` must print `OK`.
  2. **Restore into a local container** (never into Neon while testing):
     - `docker run -d --name restore-check -e POSTGRES_PASSWORD=restore -p 127.0.0.1:5439:5432 postgres:17-alpine`
     - `docker exec restore-check createdb -U postgres app`
     - `docker exec -i restore-check pg_restore -U postgres --no-owner --no-acl --exit-on-error -d app < app-YYYYMMDD.dump`
  3. **Compare exact row counts per table** with production. This query prints them; run it in the container (`docker exec restore-check psql -U postgres -d app -Atc "<query>"`) and against production in the Neon console (production project → SQL Editor, branch `main`, database `app`), so no connection string is needed:
     `select table_schema||'.'||table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int from information_schema.tables where table_schema in ('public','drizzle') and table_type='BASE TABLE' order by 1`
     Counts can differ only by writes made after the dump's creation time (the `Archive created at` line of `pg_restore --list`).
  4. **Clean up:** `docker rm -f restore-check`, delete the downloaded files.
  5. **Real recovery** (Neon lost): create a new Neon project and database `app` (Postgres 17), `pg_restore --no-owner --no-acl --exit-on-error` the dump into it (connection in `PG*` variables from an env file, as `dump.sh` does, not a URL argument), point production Hyperdrive at it and restart the pool (`owner_env main <new project id> && hd_point app_owner`, helpers in "Runtime role (ADR-0038)"; as `app_runtime` once production uses it: re-apply the grants and set a password first, see "After a restore or a promote" there), check `/api/health`. Writes after the dump are lost.
     _Drilled 2026-10-15 on disposable infrastructure (ADR-0035; the 10-15 dump): new project with role `app_owner` and database `app` 12 s, `pg_restore` done and row counts equal at 24 s, a new Hyperdrive config and Worker healthy at 59 s. `hyperdrive update` to another branch took 3 s, and the next request (6 s later) already reached the new branch without a pool restart. Not covered: updating and restarting production's Hyperdrive config, production `/api/health`, and the new `NEON_PROJECT_ID` and `NEON_API_KEY` the next backup needs (see "CI credentials")._
  - _Restore test done 2026-09-30 (steps 1–4; owner and Claude): dump `daily/app-20260930.dump` (27013 bytes), written by `db-backup.yml`'s `dump` job in a manually dispatched run (run 36773098184, archive created 20:39:10Z, server 17.11, `pg_dump` 17.10 from the pinned client image). Downloaded from the dashboard (saved as `daily_app-20260930.dump`, renamed as in step 1); `sha256sum -c` printed `OK`. `pg_restore --no-owner --no-acl --exit-on-error` into a fresh `postgres:17-alpine`: no errors. Per-table counts, restored copy = production `main` (Neon SQL Editor, shortly after): `drizzle.__drizzle_migrations` 5, `account` 2, `billing_subscription` 2, `billing_webhook_event` 18, `invitation` 0, `member` 2, `organization` 2, `project` 1, `rate_limit` 1, `session` 1, `user` 2, `verification` 0: all 12 tables equal. Container and downloaded files deleted afterwards. **This meets the data gate's "restore tested" condition** (owner decision 2026-09-30: a manually dispatched run of the `dump` job counts; ADR-0023 decision 5)._
  - _Repeated 2026-10-15, timed (owner and Claude): dump `daily/app-20261015.dump` (28470 bytes, scheduled run, archive created 09:13:34Z), `sha256sum -c` `OK`; container ready 2.4 s, `pg_restore` 0.6 s (exit 0, no output), counts query 0.1 s; all 12 tables equal to production `main`. The dashboard download and the SQL Editor take the hands-on minutes._
- Drill on the production project, 2026-09-28 (ADR-0019), using the snapshot and inspect commands of that day (the selective copy and promote steps were added or drilled later, on 2026-10-15):
  - marker in `main` → snapshot branch (`--no-compute`) → change `main`;
  - read-only compute on the snapshot: pre-change state, writes refused;
  - branch restored from the snapshot: same state, writable;
  - cleaned up afterwards. Repeat it (with a `drill-*` name, so the `backup-*` rotation isn't touched) after changing this procedure.
- Watch: monthly CU-hours (compute is suspended when exceeded; the daily dump wakes it for about a minute), the 0.5 GB storage ceiling and the 5 GB monthly egress. Accepted in ADR-0026 (2026-10-13), until the plan is upgraded:
  - **When:** every Monday and before each production deploy.
  - **What:** Neon console → production project → usage for the current period: CU-hours, storage, egress. Read-only CLI aid: `pnpm exec neon branches list --project-id flat-cherry-23373668 -o json` (`main`'s `logical_size`; `compute_time_seconds` ÷ 3600 = CU-hours; `data_transfer_bytes`).
  - **Upgrade** (ADR-0026 option 3: production alone in its own organization on Launch, rotating `NEON_API_KEY` in the order given there) at the first of: CU-hours ≥ 50 before the 15th or ≥ 70 at any point; project storage or `main`'s logical size ≥ 256 MiB; egress ≥ 2.5 GB; any compute suspension or storage-cap write failure (at once); before Polar production mode or `SIGNUP_MODE=open`.
  - **Baseline:** ADR-0026 "First reading" (2026-10-13, CLI and console agree: 31.83 MB storage, 0.63 CU-hours, 7.67 MB egress). Whether the CLI counters reset each period is unverified, so the console's figures decide the triggers.
  - Free has no consumption API (403) and no usage notifications.

### Runtime role (ADR-0038)

The app is meant to connect as `app_runtime`, which migration `0005_runtime_role` creates without a login (table grants in ADR-0038). Migrations, backups and previews stay on `app_owner`.

**Production keeps `app_owner` until every gate is recorded here:**

- [x] **G1** role, grants and Hyperdrive login verified on a disposable preview-project branch: 2026-10-16 (ADR-0038 Notes; sanitized evidence in the owner's local `R06-artifacts/runtime-check-2026-10-16.txt`).
- [ ] **G2** migration 0005 released to production: the identity check (below) on production shows `app_runtime` with its grants.
- [ ] **G3** the app working through Hyperdrive as `app_runtime`: step 2's PR preview e2e run, or an isolated Worker smoke test the owner approved.
- [ ] **G4** the owner's explicit approval to change production credentials (date and who, here).

**Secret handling.**

- A password never goes in argv, a file, a log, shell or psql history, chat or a committed artifact.
- Passwords live only in exported shell variables for one session; `unset` them at the end.
- `psql` gets the password through `\getenv`; Hyperdrive gets it in an API body on stdin; the API token goes in a header read from a file descriptor.
- Owner connections use `PG*` variables, not a URL argument, with verified TLS (`PGSSLMODE=verify-full`, `PGSSLROOTCERT=system`; libpq ≥ 16, the `postgres:17-alpine` image has the system CA bundle). Hyperdrive's default `sslmode=require` already validates the origin's certificate (WebPKI).
- Secrets never go into `docker run -e`: Docker stores those values in the container's configuration (`docker inspect`), even with `--rm`. `psqlo` feeds them to the container on stdin instead.
- Postgres receives a password set with `ALTER ROLE … PASSWORD` in plaintext. Neon refuses pre-hashed SCRAM verifiers ("Neon only supports being given plaintext passwords"), so `\password` doesn't work. The statement text reaches a server log through `log_statement`, through the duration settings, and, **if the statement fails**, through `log_min_error_statement` (default `error`), which the owner can't change. So step 1.2 checks the settings first. If the `ALTER ROLE` fails for any reason, treat that password as exposed: generate a new one, and never reuse it. Neon's own logs are outside our control. The reset-password API (below) sends no password through SQL, once verified for this role.
- Neon requires at least 60 bits of entropy; `openssl rand -hex 24` gives 192.

**Session setup.** Run in `bash`, from the repo root:

```sh
P_PREVIEW=withered-credit-11647832; P_PROD=flat-cherry-23373668; PROD_HD=e788b06678f1450eb89f8b52384ab3a3
ACCOUNT="$(grep -oE '"account_id": *"[0-9a-f]{32}"' apps/app/wrangler.jsonc | grep -oE '[0-9a-f]{32}')"
# Cloudflare token with Hyperdrive edit: Wrangler's own login, or paste one at a hidden prompt.
export CLOUDFLARE_API_TOKEN="$(pnpm --filter app exec wrangler auth token 2>/dev/null </dev/null | tail -n1 | tr -d '[:space:]')"
# Hyperdrive API: the token header comes from a file descriptor (not argv), so the body can use stdin.
hd() { curl -fsS -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/hyperdrive/configs$1" "${@:2}"; }
# Exports PG* for app_owner on branch $1 of project $2, with verified TLS. The URL never reaches argv.
owner_env() {
  local u re='^postgres(ql)?://([^:]+):([^@]+)@([^/?]+)/([^?]+)'
  u="$(pnpm exec neon connection-string "$1" --project-id "$2" --database-name app --role-name app_owner </dev/null)"
  [[ "$u" =~ $re ]] || { echo "unexpected connection string shape" >&2; return 1; }
  export PGUSER="${BASH_REMATCH[2]}" PGPASSWORD="${BASH_REMATCH[3]}" PGHOST="${BASH_REMATCH[4]}" PGDATABASE="${BASH_REMATCH[5]}" \
    PGSSLMODE=verify-full PGSSLROOTCERT=system
}
# psql in a container, SQL on stdin. The two secrets go in through stdin too, never `docker run -e`.
psqlo() { { printf '%s\n%s\n' "$PGPASSWORD" "${RUNTIME_PW:-}"; cat; } |
  docker run --rm -i -e PGUSER -e PGHOST -e PGDATABASE -e PGSSLMODE -e PGSSLROOTCERT postgres:17-alpine \
    sh -c 'IFS= read -r PGPASSWORD; IFS= read -r RUNTIME_PW; export PGPASSWORD RUNTIME_PW; exec psql -X -v ON_ERROR_STOP=1 -f - "$@"' psql "$@"; }
# Origin body for app_runtime on host $1; the password comes from the environment.
origin() { jq -n --arg h "$1" '{scheme: "postgresql", host: $h, port: 5432, database: "app", user: "app_runtime", password: env.RUNTIME_PW}'; }
# Points production Hyperdrive at the branch in PG* (owner_env) as $1 (app_owner: PGPASSWORD; app_runtime:
# RUNTIME_PW), keeps caching disabled, then restarts the pool (an update doesn't close pooled connections).
hd_point() {
  local v=PGPASSWORD r; [ "$1" = app_runtime ] && v=RUNTIME_PW
  r="$(jq -n --arg h "$PGHOST" --arg u "$1" --arg v "$v" '{origin: {scheme: "postgresql", host: $h, port: 5432,
    database: "app", user: $u, password: env[$v]}, caching: {disabled: true}}' |
    hd "/$PROD_HD" -X PATCH --data-binary @-)" || { echo "update failed; pool not restarted" >&2; return 1; }
  jq -e '.success == true' <<<"$r" >/dev/null || { jq -c .errors <<<"$r" >&2; echo "update refused; pool not restarted" >&2; return 1; }
  jq -c '{user: .result.origin.user}' <<<"$r"
  hd "/$PROD_HD/restart" -X POST | jq -e '.success == true' >/dev/null || { echo "pool restart failed" >&2; return 1; }
  echo "pool restarted"
}
# At the end: unset RUNTIME_PW PGPASSWORD CLOUDFLARE_API_TOKEN NEON_API_KEY
```

Config ids: `wrangler hyperdrive list`. Wrangler's `get`, `update` and `delete` take an id, not a name.

**Identity check** (as the owner: `owner_env <branch> <project>`, then `psqlo <<'SQL'` … `SQL`):

```sql
select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
  from pg_roles where rolname = 'app_runtime';
select roleid::regrole from pg_auth_members where member = 'app_runtime'::regrole;
select table_name, string_agg(privilege_type, ',' order by privilege_type)
  from information_schema.role_table_grants where grantee = 'app_runtime' group by 1 order by 1;
select usename, count(*) from pg_stat_activity where datname = 'app' group by 1;
```

Expected:

- one role row with every flag false except `rolcanlogin` (true once it has a login);
- no memberships;
- exactly ADR-0038's grants;
- after the switch, the Worker's connections listed under `app_runtime`.

1. **Disposable-branch check (G1; repeat after changing this procedure).** Wrap it in a `trap` that deletes the config and the branch on any exit, including a failure, as the 2026-10-16 run did.
   1. **Branch and migration:** `pnpm exec neon branches create --project-id $P_PREVIEW --name runtime-check --parent preview-seed`, then `owner_env runtime-check $P_PREVIEW && DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST/$PGDATABASE?sslmode=require" pnpm db:migrate` (the URL is built in the environment, not typed).
   2. **Set the password:**
      - Check the logging settings: `echo "select name, setting from pg_settings where name in ('log_statement', 'log_duration', 'log_min_duration_statement', 'log_min_duration_sample', 'log_min_error_statement') union all select 'pg_stat_statements', exists (select from pg_extension where extname = 'pg_stat_statements')::text order by 1" | psqlo -At`. It must show `log_statement` `none`, `log_duration` `off`, both `log_min_duration_*` `-1`, and `pg_stat_statements` `false`. Otherwise stop and use the API alternative below. `log_min_error_statement` (normally `error`) logs the statement only if it fails, so a failure means a new password.
      - `export RUNTIME_PW="$(openssl rand -hex 24)"`
      - `printf '%s\n' '\getenv pw RUNTIME_PW' "alter role app_runtime login password :'pw';" | psqlo -q`. If it reports any error, `unset RUNTIME_PW` and start this step again with a new password.
   3. **Identity check** as above.
   4. **Hyperdrive:**
      - `origin "$PGHOST" | jq '{name: "saas-runtime-check", caching: {disabled: true}, origin: .}' | hd "" -X POST --data-binary @- | jq '{success, id: .result.id, user: .result.origin.user}'`. Hyperdrive connects to the origin when it creates a config, so success proves the login, TLS and database access.
      - Negative check: the same body with a wrong password must fail with code 2013.
   5. **Clean up:** `hd "/<id>" -X DELETE | jq .success`, `pnpm exec neon branches delete runtime-check --project-id $P_PREVIEW`, then `wrangler hyperdrive list` and `neon branches list` show only `saas-foundation-prod` and `preview-seed`.
2. **App through Hyperdrive (G3; needs Actions):**
   - On a PR preview, `owner_env preview/pr-<N> $P_PREVIEW`, then set a password on that branch (step 1.2).
   - `origin "$PGHOST" | jq '{origin: .}' | hd "/<id of saas-pr-N>" -X PATCH --data-binary @- | jq .success`, then `hd "/<id of saas-pr-N>/restart" -X POST`.
   - Re-run the preview's e2e job. It must pass with the Worker's connections listed under `app_runtime` (identity check, last query).
   - Closing the PR deletes the config as usual (ADR-0021).
   - An isolated remote Worker smoke test is the alternative only with the owner's approval: it's a new Worker (invariant 14).
3. **Production password (after G1–G4):** `owner_env main $P_PROD`, then step 1.2's three commands, then the identity check.
4. **Switch:**
   - `wrangler hyperdrive get $PROD_HD` for the current host.
   - `owner_env main $P_PROD && hd_point app_runtime`, which also restarts the pool.
   - `wrangler hyperdrive get $PROD_HD` must show user `app_runtime`, caching disabled.
5. **Confirm:**
   - `/api/health` answers 200;
   - signing in, opening a tenant, and creating and deleting a project all work;
   - the identity check's last query lists `app_runtime`;
   - Workers Issues and Logs show no `permission denied` (SQLSTATE `42501`) for an hour.

   Record the date here, then `unset RUNTIME_PW PGPASSWORD CLOUDFLARE_API_TOKEN`.

**API alternative for setting the password (step 1.2):** Neon's reset-password endpoint generates the password itself, so nothing goes through SQL. It needs a Neon API key with access to the project (`read -rs NEON_API_KEY && export NEON_API_KEY`). It's **unverified for a role created in SQL**: try it on a disposable branch first, and re-run the identity check afterwards, which must still show no memberships (no `neon_superuser`).

```sh
BRANCH_ID="$(pnpm exec neon branches list --project-id <project> -o json </dev/null | jq -r --arg b <branch> '.[] | select(.name == $b) | .id')"
echo 'alter role app_runtime login' | psqlo   # reset_password sets a password, not LOGIN
export RUNTIME_PW="$(printf 'Authorization: Bearer %s\n' "$NEON_API_KEY" |
  curl -fsS -H @- -X POST "https://console.neon.tech/api/v2/projects/<project>/branches/$BRANCH_ID/roles/app_runtime/reset_password" |
  jq -r .role.password)"
```

**Rollback** (any time after step 4):

- `owner_env main $P_PROD && hd_point app_owner`.
- Check `/api/health`; `wrangler hyperdrive get $PROD_HD` shows `app_owner`.
- To revoke the runtime credential as well: `echo 'alter role app_runtime nologin' | psqlo`.
- The role and its grants can stay; removing them is a contract migration.

**After a restore or a promote:**

- A dump restored with `--no-acl` has no grants. Re-apply them as the owner: `psqlo < packages/db/drizzle/0005_runtime_role.sql` (idempotent), plus any later grant migration.
- Give `app_runtime` a new password (step 1.2), and use it wherever "Full rollback" or "Real recovery" points Hyperdrive at `app_owner`. Snapshot branches keep the role, but its password can't be read back, so set a new one.

**A new table** gets no runtime privileges until a migration grants them. A `42501` error on a table that was just released means its grant migration is missing.

## Releases (ADR-0029)

The default way to deploy production. Every merge to `main` updates one release PR (`chore(main): release app X.Y.Z`, branch `release-please--branches--main--components--app`; no preview). Only `feat`, `fix`, `perf`, `refactor` and `revert` titles release.

1. **Owner:** open the release PR, click **Approve workflows to run** (it's opened with `GITHUB_TOKEN`), wait for green CI, then squash-merge it. Merging is the approval to deploy. Prerequisite (once per repo): Settings → Actions → General → Workflow permissions → **Allow GitHub Actions to create and approve pull requests**, keeping the default token read-only (`gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`). Without it release-please pushes its branch but fails to open the PR ("GitHub Actions is not permitted to create or approve pull requests"); enable it, then re-run the failed Release run.
2. The same `release.yml` run (Actions → Release) creates tag and release `app-vX.Y.Z`, builds the tag without secrets and runs the `deploy` job in `production`: the tag must be on `main`'s history and the artifact must pass ADR-0021's rules → preflight (deployed secrets; no candidate already held) → an automatic release deploys only the newest `app-v*` tag → breaking-release guard → only if migrations are pending: restore point `pre-migrate-<tag>-<utc>` (the newest 2 are kept) and the tag's migrations with `main`'s migrator (a pending contract migration requires the preceding release live at 100%; a journal entry older than the newest applied one stops the release) → candidate at 0% → smoke test through `Cloudflare-Workers-Version-Overrides` (must report the build's id) → promote to 100% → health check.
3. **Hold:** set the **repository** variable `RELEASE_HOLD=true` before merging (`gh variable set RELEASE_HOLD --body true`; an environment variable isn't read) and the job stops after the smoke test with the candidate at 0%. It also stops there when `apps/app/wrangler.jsonc` differs from the live release's, or the live version has no release tag (the first release does, and so does a version made by `wrangler secret put`: they hold); apply route or trigger changes by hand first. Test by hand with `curl -H 'Cloudflare-Workers-Version-Overrides: saas-foundation="<version id>"' https://app.aaronlabr.dev/api/health` (the id is in the job's notice), then run **Release → Run workflow → `promote`**. Unset the variable afterwards (`gh variable delete RELEASE_HOLD`).
4. **Failure:** a failed smoke test leaves the candidate at 0% (users never saw it). A held or failed candidate blocks the next release, redeploys and rollbacks: run **Release → `discard`** (the live version alone at 100%), then fix forward, or `promote` if it was a false alarm. "Re-run failed jobs" reuses the build and its build id. If migrations ran but the deploy didn't, the schema is ahead of the code; that's safe while migrations are expand-only (Invariant 10).
5. **Redeploy a tag:** Release → Run workflow → `redeploy`, `tag: app-vX.Y.Z` (on `main`'s history; optionally `hold`). Every deploy runs the breaking-release guard: it's refused if production has applied a contract migration the tag lacks, unless `confirm_breaking`.
6. Afterwards: `curl -s https://app.aaronlabr.dev/api/health` reports `version`, `commit` and `build` (the release run's id).

**After the rename to `app` (ADR-0033 decision 11):** releases up to 0.2.0 are tagged `web-v*`, everything after `app-v*`. The first `app-v*` release holds at 0% once, because the live version's tag `web-v0.2.0` doesn't count as a release tag any more: check it with the override header as in step 3, then `promote`. A `web-v*` release can't be redeployed with `release.yml`; go back to one with Rollback (by version id). If a secret must change while a `web-v*` version is rolled back to, use the manual fallback below.

Fallback when CI or the token is unavailable: the manual sequence ("First production deploy" step 0, then a restore point, `pnpm db:migrate`, `pnpm run deploy`). It bypasses the candidate stage and its versions carry no tag. To roll back without CI, see "Rollback" → manual fallback.

## Rollback (ADR-0029)

Code only, seconds, no build: **Actions → Rollback → Run workflow** with a short `reason` (the message `rollback by <you>: <reason>` must fit 120 characters) and the target `version_id` (required; ids from `pnpm --filter app exec wrangler deployments list`, usually the previous 100% version). It refuses while a candidate is held (`discard` it first); refuses a target lacking a contract migration production has applied (or one not uploaded by `release.yml`, such as a manual deploy or a `wrangler secret put` version, whose commit is unknown) unless `confirm_breaking`; and refuses a target older than a secret change (or than the 10 newest versions) unless `confirm_secret_revert`, because wrangler then restores the old secret values without asking in CI. It succeeds only once the target serves 100% (and, for a release, `/api/health` reports its version and build). **In an emergency, roll back first, then fix forward.** The database is never rolled back by a workflow: restoring loses writes since the restore point, so it stays the manual "Database" procedure, using the `pre-migrate-*` branch or a snapshot.

**Manual fallback** (Actions down, or a rollback run stuck behind the `deploy-saas-foundation` queue): the workflow's own scripts with the owner's logins, from an up-to-date checkout of `main` (`git fetch`; the guard reads the target commit's journal). The pieces are the workflow's. _Drilled 2026-10-15 ~20:05Z (owner's logins, from `main` at 68c7aba): steps 1–4 on the app without rolling it back (target `79045c47` = app-v0.3.1, live `0ef56ba5`; step 1 took 7 s, `secrets_changed=false`; the guard took 3 s, no missing contract migration; the stale check showed only the live version), then steps 4–5 for real on the docs Worker, which has no secrets or data: `wrangler rollback` from `03276d6f` (4a8e260) to `ac0e2693` (5377d84) with `-y` then `wrangler deployments status` showed `ac0e2693` alone at 100%, and `/version.json` reported 5377d84 18 s after the start of the stale check; `/` and `/llms.txt` answered 200. The roll forward to `03276d6f` the same way: status showed it alone at 100%, `/version.json` reported 4a8e260 after 10 s, `/index.md` answered 200, and the app's `/api/health` stayed `ok`. On the app, run step 4 in an interactive terminal without `-y` (step 2 still decides)._

1. `export CLOUDFLARE_API_TOKEN="$(pnpm --dir apps/app exec wrangler auth token | tail -1)"`, then `VERSION_ID=<target> GITHUB_OUTPUT=/dev/stdout scripts/release/rollback-target.sh`: prints `commit`, `tag`, `live` and `secrets_changed` (it refuses while a candidate is held: `discard` first).
2. If `secrets_changed` isn't `false`, the rollback restores old secret values: stop unless that's intended.
3. `COMMIT=<commit from step 1> NEON_PROJECT_ID=flat-cherry-23373668 NEON_DATABASE=app NEON_ROLE=app_owner NEON_API_KEY=<from neon auth> scripts/release/rollback-guard.sh`: refuses a target lacking an applied contract migration (or with an unknown commit) unless `CONFIRM_BREAKING=true`.
4. **Stale check, right before rolling back:** `pnpm --dir apps/app exec wrangler deployments status` must show only the `live` version from step 1 at 100%. If anything else changed (a deploy, a candidate), start again at step 1. Then `pnpm --dir apps/app exec wrangler rollback <target> -m "rollback by <you>: <reason>"` (≤ 120 characters). Without `-y`, in an interactive terminal, wrangler asks before reverting changed secrets: answer as decided in step 2. It accepts on its own when not interactive (as in CI), so step 2's decision is the safeguard, not the prompt.
5. `pnpm --dir apps/app exec wrangler deployments status` shows the target alone at 100%; `curl -s https://app.aaronlabr.dev/api/health` is `ok` (a release target also reports its version and build).

**Secrets while rolled back or after a `discard`:** the newest uploaded version is then not the deployed one, so `wrangler secret put` refuses, and `wrangler versions secret put` would build on that newest upload, re-shipping the code you just left. Redeploy the good tag first (Release → `redeploy`), then change the secret.

Verified on the first release (web 0.2.0, 2026-10-14): `versions upload` writes the version id to `WRANGLER_OUTPUT_FILE_PATH`, and `versions deploy` works with the per-Worker token (candidate at 0%, then `promote`). Drilled 2026-10-15 (ADR-0029 Notes 2026-10-15): `wrangler rollback` with that token works, about 50–70 s from dispatch to green for the app and 45–60 s for docs and site; the breaking-release guard refused a manual version with "Roll back" skipped; and a rollback past a secret change does restore the old secret value without asking in CI. Secret changes are recognised by the `workers/triggered_by: secret` annotation (seen on production versions, 2026-10-13).

## Docs (ADR-0028)

The public docs site `apps/docs` is its own assets-only Worker, `saas-foundation-docs`, on `https://docs.aaronlabr.dev`. It has no bindings, secrets or data, so its deploys are continuous and need no approval.

Its workflows (`docs.yml`, `docs-preview.yml`, `docs-deploy.yml`, `docs-rollback.yml`) call the shared static-site workflows `static-*.yml`, which run `scripts/sites/*.sh` with `SITE=docs` (ADR-0033 decision 9).

- **PR preview:** a same-repo PR that changes the docs build (`docs.yml`'s paths) gets Worker Preview `pr-N` of `saas-foundation-docs-preview` on workers.dev, posted as a PR comment (`docs-preview.yml`; the preview is deleted when the PR closes, tidiness only). Previews are public: a docs PR contains nothing you wouldn't publish.
- **Production:** every merge to `main` that changes the docs build deploys it at 100% (`docs-deploy.yml`): build without secrets, `versions upload --tag docs-<sha7> --message <sha>`, `versions deploy`, smoke test of `/`, `/llms.txt`, `/index.md` and `/version.json` (which reports the commit). **Redeploy** a commit: Actions → Docs deploy → Run workflow, `commit` = a full SHA on `main`'s history.
- **Rollback:** Actions → Docs rollback → Run workflow with a `reason` and the target `version_id` (`pnpm --filter docs exec wrangler deployments list`). Seconds, no build, nothing else to guard. Locally, with your own login, from `apps/docs`: `pnpm exec wrangler rollback <version-id>`.
- **Routes and domain:** CI never changes them (per-Worker tokens can't manage custom domains). If `routes` in `apps/docs/wrangler.jsonc` changes, apply it once by hand from a clean `main`: `pnpm --filter docs build && pnpm --filter docs exec wrangler deploy`.
- **Setup (owner, done 2026-10-14):** Workers `saas-foundation-docs` (created by the manual `wrangler deploy` that attached `docs.aaronlabr.dev`, version `80debee2`) and `saas-foundation-docs-preview` (dashboard, Hello World until the first preview, with **Settings → Domains & Routes → Preview URLs enabled**: a Worker-level setting that `wrangler preview` doesn't change; without it a Preview deploys with no URL); tokens and environments in "CI credentials". **Rotate** a token: roll it in the dashboard, `gh secret set CLOUDFLARE_DOCS_TOKEN --env docs` (or `CLOUDFLARE_DOCS_PREVIEW_TOKEN --env docs-preview`), then run a redeploy or a docs PR preview.

## Site (ADR-0033)

The marketing site `apps/site` is its own assets-only Worker, `saas-foundation-site`, on the apex `https://aaronlabr.dev`. Same pipeline as the docs (`site.yml`, `site-preview.yml`, `site-deploy.yml`, `site-rollback.yml`, calling `static-*.yml` with `SITE=site`): PR previews on `saas-foundation-site-preview`, continuous deploys at 100% tagged `site-<sha7>`, smoke test of `/`, `/pricing/`, `/robots.txt` and `/version.json`, and rollback by version id. It links to the app and never shares its session.

- **Prices:** plans, limits and the trial come from `billing/policy.ts` through `apps/site/src/data/plans.json` (`pnpm plans:export`; `pnpm check` fails while it's stale). Amounts are in `apps/site/src/data/prices.json`, by price key, in minor units. **Keep them equal to the Polar dashboard:** when you change a product's price in Polar, change `prices.json` in the same session. The build refuses a purchasable price without an amount and an amount for a price that isn't purchasable; it can't check the values against Polar. Template values: the sandbox's $29/month and $290/year (2026-09-30).
- **Calls to action:** `signupMode` in `apps/site/src/config.ts`. `allowlist` (now): "Request access" (mail to the contact address) and "Sign in". Switch it to `open` in the same release that opens sign-up (milestone D).
- **Setup (owner).** Before merging the PR that adds the site:
  1. Route the contact address (`hello@aaronlabr.dev` in `apps/site/src/config.ts`) with Email Routing, or change it to a routed one.
  2. Check `prices.json` against Polar.
  3. Create the environments `site` and `site-preview`, both restricted to `main` (a workflow that names a missing environment creates it unrestricted).
  4. Create the Worker `saas-foundation-site-preview` in the dashboard (Hello World), with **Settings → Domains & Routes → Preview URLs enabled**, as for the docs preview Worker; then an account-owned token with Workers **Editor** on **Specified Workers → `saas-foundation-site-preview`**, stored as `CLOUDFLARE_SITE_PREVIEW_TOKEN` in `site-preview` (`gh secret set CLOUDFLARE_SITE_PREVIEW_TOKEN --env site-preview`).

  After merging (the merge's `Site deploy` run fails until step 6: no token yet):

  5. From a clean `main`, with your own login: `pnpm --filter site build && pnpm --filter site exec wrangler deploy`. This creates `saas-foundation-site` and attaches the apex Custom Domain (the apex must have no other DNS record).
  6. An account-owned token with Workers **Editor** on **Specified Workers → `saas-foundation-site`**, stored as `CLOUDFLARE_SITE_TOKEN` in `site`; then re-run the failed `Site deploy` run (or dispatch it with the commit). It smoke-tests the apex.

- **Routes and domain:** as for the docs, CI never changes them; apply a `routes` change by hand with step 5's command. `www` isn't served; add a zone Redirect Rule to the apex if you want it to resolve.
- **Rotate** a token: roll it in the dashboard, `gh secret set CLOUDFLARE_SITE_TOKEN --env site` (or `CLOUDFLARE_SITE_PREVIEW_TOKEN --env site-preview`), then run a redeploy or a site PR preview.

## First production deploy (owner sequence, 2026-09-28)

First deployed 2026-09-30 (milestone A, Worker version `25fc77e3-28a8-4eba-92b3-f902f1b14d91`); steps 0–11 are done (milestones A and B, 2026-09-30). Steps marked **owner** need credentials, accounts or dashboard access. Don't skip or reorder.

**Data gate (ADR-0014):** until off-provider backup option B is implemented **and** a restore from it has been tested, production holds **only synthetic smoke-test accounts**, never real customer data. Sign-up is enforced in code: with `SIGNUP_MODE` unset (the production default), sign-up is **closed** except for the exact addresses in `SIGNUP_ALLOWLIST`.

- **Before step 7:** `pnpm --filter app exec wrangler secret put SIGNUP_ALLOWLIST` with the comma-separated smoke-test addresses. Don't set `SIGNUP_MODE` in production.
  - _Done 2026-09-30 (a third added on 2026-10-01 for the email smoke test, runbook "Email"): two plus-addresses of the owner's own mailbox (real MX, so they also work as Polar sandbox customers; never a public inbox such as Mailinator, whose messages anyone can read). `SIGNUP_MODE` unset._

**Launch milestones (owner, 2026-09-29).** Four separate gates, in order. C and D are separate decisions, each recorded in its own ADR; lifting the data gate does **not** open sign-up.

- **A. Technically deployed:** production DB migrated, Worker deployed (steps 0–7). Sign-up allowlisted to smoke-test addresses; no real customer data, no Polar production mode, no public sign-up.
- **B. Internal production smoke complete:** smoke test passed (step 8), WAF rule applied and tested (steps 9–10), the previous broad Cloudflare user token confirmed revoked (step 11). Still no real customer data.
- **C. Real customer data, sign-up still allowlisted:** backup option B implemented and a restore from it tested (ADR-0014), alerting operational (ADR-0015, ADR-0031), email delivery live and email verification enforced (ADR-0016), smoke-test accounts removed, and a new ADR lifting the data gate (ADR-0032, accepted 2026-10-14: a free pilot on Polar's sandbox; takes effect when its Rollout step 5 records the lifting). Then, after deleting the smoke-test accounts and recording the lifting (ADR-0032 Rollout steps 1–5), `pnpm --filter app exec wrangler secret put SIGNUP_ALLOWLIST` with only the admitted customers' addresses (no smoke-test address left in it), and keep `SIGNUP_MODE` unset.
- **D. Public sign-up (`SIGNUP_MODE=open`):** its own ADR, after C, covering a bot-protection decision (Turnstile, ADR-0005), the WAF rule live, legal pages (privacy, terms, subprocessors), and Neon Free's capacity limits (ADR-0003) explicitly accepted or the plan upgraded (accepted 2026-10-13 with an upgrade trigger, ADR-0026).
- Polar production mode (section "Polar") needs C first, since paying customers are real data, and its sandbox checks passed.

**Smoke-test users removal (ADR-0032 Rollout step 3, owner, once).** After step 2 has deleted every smoke-test organization through Better Auth. No user-deletion endpoint is enabled, so it's SQL, in the Neon console (production project → SQL Editor, branch `main`, database `app`). In both statements, replace the `VALUES` list with **every** smoke-test address ever allowlisted (four by the records: section "Data gate" above and runbook "Email" steps 2 and 5), typed in the editor only: never commit or paste the addresses anywhere else (the SQL Editor keeps them in its query history; they are the owner's own plus-addresses). Deleting a user cascades to its sessions and accounts (passwords); the statement also deletes its password-reset tokens (`verification` rows keyed by user id).

- Check first:

  ```sql
  WITH smoke(email) AS (VALUES ('<smoke address 1>'), ('<smoke address 2>')),
  targets AS (SELECT id FROM "user" WHERE email IN (SELECT lower(email) FROM smoke))
  SELECT
    (SELECT count(*) FROM "user") AS all_users,
    (SELECT count(*) FROM targets) AS smoke_users,
    (SELECT count(*) FROM session WHERE user_id IN (SELECT id FROM targets)) AS sessions,
    (SELECT count(*) FROM account WHERE user_id IN (SELECT id FROM targets)) AS accounts,
    (SELECT count(*) FROM verification WHERE identifier LIKE 'reset-password:%' AND value IN (SELECT id FROM targets)) AS reset_tokens,
    (SELECT count(*) FROM organization) AS organizations,
    (SELECT count(*) FROM member WHERE user_id IN (SELECT id FROM targets)) AS memberships,
    (SELECT count(*) FROM invitation WHERE inviter_id IN (SELECT id FROM targets) OR lower(email) IN (SELECT lower(email) FROM smoke)) AS invitations,
    (SELECT count(*) FROM project WHERE created_by IN (SELECT id FROM targets)) AS projects;
  ```

  Go on only if `all_users` = `smoke_users` (production holds only smoke-test accounts; another user means an address is missing from the list, or someone else signed up: stop) and `organizations`, `memberships`, `invitations` and `projects` are all 0 (otherwise step 2 isn't finished). Note `smoke_users`.

- Delete (one statement, so it applies entirely or not at all):

  ```sql
  WITH smoke(email) AS (VALUES ('<smoke address 1>'), ('<smoke address 2>')),
  targets AS (SELECT id FROM "user" u WHERE email IN (SELECT lower(email) FROM smoke)
    AND NOT EXISTS (SELECT 1 FROM member m WHERE m.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM invitation i WHERE i.inviter_id = u.id)),
  reset_tokens AS (DELETE FROM verification WHERE identifier LIKE 'reset-password:%' AND value IN (SELECT id FROM targets) RETURNING 1),
  users AS (DELETE FROM "user" WHERE id IN (SELECT id FROM targets) RETURNING 1)
  SELECT (SELECT count(*) FROM users) AS users_deleted, (SELECT count(*) FROM reset_tokens) AS reset_tokens_deleted;
  ```

  `users_deleted` must equal `smoke_users`. A user still in an organization or with a sent invitation is skipped (a lower count; finish step 2 for it, then rerun); a project they created makes the whole statement fail with `project_created_by_user_id_fk` and deletes nothing.

- Check again with the first statement: every column 0, `all_users` included. Record in ADR-0032 step 3 the date, `users_deleted` and `reset_tokens_deleted` (no addresses or ids).

0. **Preflight:** a clean checkout of `main` at the commit to deploy, Node 24 (`.node-version`), then `pnpm install --frozen-lockfile` (pnpm version from `packageManager`). `pnpm check && pnpm test` pass.
   - _Done 2026-09-30 at `29ce6da`, in a separate detached worktree (`git worktree add --detach <path> origin/main`, no `.dev.vars`): `pnpm check` passed, `pnpm test` 185 passed. Not the main checkout: ESLint also lints git-ignored worktrees nested under `.claude/worktrees/`, which failed `pnpm check` there._

1. **GitHub `production` environment:** exists, restricted to deployment branch `main` (ADR-0013; this repo's environment secrets and branch rules were verified to work). Required reviewers aren't available on this plan, so the human gate is the owner running the deploy by hand (step 7). **Before launch:**
   - `NEON_API_KEY` (production-project-scoped Neon key) is set in `production` (section "CI credentials");
   - a dispatched backup run with that key succeeded: `gh workflow run db-backup.yml`. The script always lists the project's branches with the key first, so success proves the key authenticates; a project-scoped key has full rights inside its project. If today's `backup-YYYYMMDD` already existed, no new branch is created, and tomorrow's scheduled run must show a new one;
   - the repo-level `NEON_API_KEY` is gone.
   - _All three done 2026-09-29 (section "CI credentials")._
2. **Owner:** production `BETTER_AUTH_SECRET`: `openssl rand -base64 32 | pnpm --filter app exec wrangler secret put BETTER_AUTH_SECRET` (never pasted into chat, never committed).
   - _Done 2026-09-30 04:04Z. The Worker didn't exist yet, so `wrangler secret put` (stdin not a terminal) created a draft Worker `saas-foundation` with a placeholder script and no routes, then stored the secret; step 7 replaced the script. `wrangler secret list` showed the name only._
3. **Owner:** production `BETTER_AUTH_URL` = `https://<production hostname>`, i.e. the custom-domain `routes` pattern in `apps/app/wrangler.jsonc` (ADR-0017), set with `wrangler secret put` (a secret, not a var: `scripts/check-secrets.mjs --deployed`, run by `pnpm run deploy` and the release preflight, refuses a production Worker without `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL` secrets).
   - _Done 2026-09-30 (owner): `wrangler secret list` shows `BETTER_AUTH_URL` with `BETTER_AUTH_SECRET` and `SIGNUP_ALLOWLIST` (names only). Piping the value in (`echo https://<hostname> | … secret put`) is fine: wrangler trims the trailing newline of piped input._
4. Custom domain: the production hostname is configured in `wrangler.jsonc` (`routes[].custom_domain`). Cloudflare creates its DNS record and certificate on the first deploy. The production zone is already active in the account. Production Hyperdrive `saas-foundation-prod`: **done 2026-09-28** (ADR-0019), id in `wrangler.jsonc`. To re-verify without deploying: build, copy `apps/app/dist` somewhere without `.dev.vars` (the build copies it into `dist/server/`), drop `routes` from the copy's `dist/server/wrangler.json`, run `wrangler dev --remote --config dist/server/wrangler.json --ip 127.0.0.1`, and send exactly one request, `GET /api/health`, expecting `"ok":true,"db":"up"` (plus the build fields). That route only runs `SELECT 1`. The session runs the whole app against production data, so send nothing else and stop it immediately. Stop the session by the parent PID of its `workerd` (ss -ltnp), since `workerd` respawns otherwise.
   - _Re-verified 2026-09-30 before migrating: one `GET /api/health` returned `{"ok":true,"db":"up"}`; session stopped as described._
5. Observability: `observability.enabled` is on in `apps/app/wrangler.jsonc`. After the deploy (step 7), check that requests show up in the dashboard (Workers & Pages → `saas-foundation` → Logs) or live with `pnpm --filter app exec wrangler tail saas-foundation --format pretty`. Logs must contain no secrets or PII (ADR-0015). The alerting requirement from ADR-0015 must be met before milestone C (real customer data).
   - _Done 2026-09-30 with `wrangler tail` during step 8: requests showed up (method, URL, outcome), though a request sent seconds after the tail connected didn't; the only log lines were `better_auth` warnings (`User not found`, `Invalid password`) and `email.delivery_disabled` (`kind: verification`); no emails, bodies, cookies or tokens; server-function paths show as `REDACTED`. Within minutes of the first deploy, scanners requested `/.env` and `/.git/HEAD` (outcome `Ok`, response status not captured); neither path exists in the static assets (only `assets/`), so both reached the app._
6. **Restore point, then migrations.**
   - Take a restore point **synchronously, right before migrating**. Don't rely on `db-backup.yml`: it's asynchronous and skips if today's `backup-YYYYMMDD` already exists. Instead run `pnpm exec neon branches create --project-id flat-cherry-23373668 --name "pre-migrate-$(date -u +%Y%m%d-%H%M)" --parent main --no-compute` and check it appears in `pnpm exec neon branches list --project-id flat-cherry-23373668` with a creation time from just now. Delete it once the release is verified; it uses one of Neon Free's 10 branches. _2026-09-30: `pre-migrate-20260930-0415` created at 04:15:13Z (listed, `ready`), deleted after step 8._ On Neon Free, PITR only reaches back 6 h.
   - Migrate: `DATABASE_URL="$(pnpm exec neon connection-string main --project-id flat-cherry-23373668 --database-name app --role-name app_owner)" pnpm db:migrate`. Direct (non-pooler) URL, never printed or logged.
   - Pending now (the database is empty): `0000` (slice schema), `0001` (`rate_limit`), `0002` (billing tables), `0003` (the subscription-id unique constraint becomes unique per provider), `0004` (the billing subscription's organization foreign key is dropped and re-added with `ON DELETE CASCADE`, ADR-0020). They create tables or replace constraints; none drops a column or data.
   - _Done 2026-09-30: `drizzle.__drizzle_migrations` has 5 rows whose `created_at` equal the `when` of `0000`–`0004` in `packages/db/drizzle/meta/_journal.json`. The migrate ran from the owner's main checkout at the same commit as step 0._
7. First deploy: `pnpm run deploy` (not `pnpm deploy`, which is a pnpm built-in) from the step 0 checkout, using the owner's logged-in `wrangler`. The deploy itself uses the owner's local credentials, not CI; no CI credential can deploy the production Worker (runbook "CI credentials"). Only the production-project Neon key (`production` environment) reaches the production database directly; the two preview Cloudflare tokens can still reach production data indirectly (the Worker token can bind production Hyperdrive, the Hyperdrive token can edit it; ADR-0021, section "CI credentials").
   - _Done 2026-09-30 (owner, with `pnpm run deploy` in the step 0 worktree): the output showed `app.aaronlabr.dev (custom domain)`, version `25fc77e3-28a8-4eba-92b3-f902f1b14d91`. `/api/health` over HTTPS answered `{"ok":true,"db":"up"}` with a valid certificate. The tail showed plain `http://app.aaronlabr.dev/` requests reaching the Worker (outcome `Ok`; status and any redirect not captured), so the owner enabled the zone's **Always Use HTTPS** the same day; afterwards `HEAD http://app.aaronlabr.dev/` answered 301 to `https://app.aaronlabr.dev/`. It's a zone setting, not in this repo: keep it when the zone configuration moves to infrastructure as code._
8. Smoke test on the custom domain:
   - `/api/health` returns `ok`
   - sign-up, login, create an organization
   - invitation and password-reset emails, if delivery is activated (ADR-0016, "Activation")
   - login rate limit: 6 wrong-password POSTs to `/api/auth/sign-in/email` from one IP within 60 s; the 6th returns **429**
   - _Done 2026-09-30 (owner, browser; `wrangler tail` alongside): `/api/health` ok; sign-up with an allowlisted address, sign-out and sign-in, organization created; a non-allowlisted address was refused; emails skipped (delivery not activated, one `email.delivery_disabled` log at sign-up). Rate limit: 6 wrong-password sign-ins at 04:31:16–22Z; the first 5 logged `Invalid password`, the 6th logged nothing and the page showed "Too many requests. Please try again later.". Repeated with curl at 04:42:07–13Z (6 wrong-password POSTs from one IP): 401 five times, then **429**._
9. **Owner:** add the WAF rule `auth-login-burst` (ADR-0014).
   - _Done 2026-09-30 (owner): rule reported deployed, created from ADR-0014's settings; step 10 exercised it._
10. Smoke-test the WAF on its own: more than 10 POSTs to `/api/auth/sign-in/email` within 10 s from one IP are blocked at the edge (Cloudflare block page, visible in Security → Events). Wait 60 s so the app's own limit resets, and check that a normal login still works.
    - _Done 2026-09-30 (curl from one IP, wrong password): 12 POSTs over about 7.5 s (a new connection each) were all answered by the app (401 five times, then its 429); no edge block. Then 20 POSTs over one connection, 06:37:01.2–06:37:06.5Z: the first 10 got the app's 429 (`text/plain;charset=UTF-8`, about 0.3 s each), the last 10 a different 429 (`text/plain; charset=UTF-8`, about 0.12 s each); Security → Events listed 5 events at 06:37:03–04Z (owner). After more than 60 s the owner's normal login worked._
11. **Owner:** confirm the previous broad Cloudflare user token (the old CI token, which could deploy any Worker) is revoked: dashboard → My Profile → API Tokens. CI no longer uses it (ADR-0019, ADR-0021), but only revocation removes its reach. This completes milestone B.
    - _Done 2026-09-30 (owner): the user API token is removed and no user API tokens remain. Account API tokens left: `saas-foundation-preview-infra` and `saas-foundation-preview` (section "CI credentials") and `saas-foundation`, Workers Editor on the production Worker only, stored in no GitHub secret; the owner keeps it for a future CI deploy, which needs its own ADR first._

Rollback: `wrangler rollback` to the previous Worker version (code only). Migrations are forward-only (expand → migrate → contract). For data, use the Database section below.

Planned: routine deploys, migrations after launch.
