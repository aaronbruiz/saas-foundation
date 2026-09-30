# Runbooks

## Previews (ADR-0021)

**Invariant:** preview resources are created and removed by CI. Normal preview lifecycle operations (create, reset, deploy, revoke) require no human intervention. Manual operations are administrative or recovery procedures only.

- **Per PR:** Neon branch `preview/pr-<N>` (child of `preview-seed` in the preview project, its own `app_owner` password) and Hyperdrive config `saas-pr-<N>` (caching off). Hyperdrive ids are never reused: a closed PR's config is deleted, a reopened PR gets a new one. **Deleting the config is what revokes database access.** A 404 from a deleted Preview URL is not: deleted Previews and their deployment URLs can keep executing (Cloudflare Previews beta).
- **Flow** (`.github/workflows/preview.yml`, `workflow_run` after CI; default-branch code only):
  - `resolve`: the one open same-repo PR whose head is the CI run's commit;
  - `infra` (environment `preview-infra`): `scripts/preview/infra.sh up` creates the branch, or resets its data to the seed, and creates or reuses the guarded config; never sees the artifact;
  - `deploy` (environment `preview`): `scripts/preview/deploy-artifact.sh` validates the artifact (`apps/web/dist` + `packages/db/drizzle` from CI), migrates with the default-branch migrator, patches the config to that id (`prepare-config.mjs`) and runs `wrangler preview`. A refused config lists each reason; a legitimate new key or binding needs the validator updated on `main` first;
  - `e2e`: the default-branch Playwright suite against the URL, then a PR comment.
- **Close** (`preview-cleanup.yml`, `pull_request_target`): `cleanup-preview` runs `scripts/preview/down.sh` (deletes the Preview), then `cleanup-infra` runs `scripts/preview/infra.sh down` (deletes the config, then the branch). Both act only on a PR that GitHub reports closed right now. A preview run and close-triggered cleanup of one PR hold the same lock (`preview-pr-N`, whole workflow, no in-progress cancellation, up to 100 pending runs queued), so cleanup waits for a running preview, E2E included; the janitor skips PRs whose preview run is still active. **Daily janitor:** `janitor.sh` and `infra.sh janitor` do the same for closed PRs a run missed.
- **By hand** (recovery), with the logged-in sessions instead of CI secrets:
  - `CLOUDFLARE_API_TOKEN="$(pnpm --dir apps/web exec wrangler auth token | tail -1)"` (it can do both sides; CI never has one token for both);
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

- **Dashboard:** Workers & Pages → `saas-foundation` → Observability (Logs / Events). Filter by `level = error`, by `event` (`server_fn.unhandled`, `health.db_down`, `better_auth`), or by `rayId`.
  - A user-reported Cloudflare ray id (shown on Cloudflare error pages) matches `rayId`.
  - Each request's invocation log shows its status and outcome.
- **Live:** `pnpm --filter web exec wrangler tail saas-foundation --format pretty --search '"level":"error"'`. Don't rely on `--status error`: it filters on the invocation's outcome, and server-function failures are turned into responses, so those invocations end `ok`.
- **Health:** `curl -s https://<domain>/api/health` returns `{ ok, db }`. A `503` means the database is unreachable; the reason is in the `health.db_down` event.
- **Retention:** 7 days (Workers Paid). Copy anything needed longer into the incident notes, without PII.
- **Never** paste log lines containing user data into tickets or chat. The logger redacts emails and URL credentials; check anything you copy.

## CI credentials (ADR-0019, ADR-0021)

No preview secret lives at repo level: a `pull_request` workflow runs the PR's own YAML and could read it. Every secret sits in an environment that only `main` may use, and only default-branch code (`workflow_run`, `pull_request_target`, schedule) uses it.

| Secret                           | Where                                      | Scope                                                                                             | Used by                                                     |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `NEON_API_KEY`                   | environment `production` (`main` only)     | Neon org key limited to the production project                                                    | `db-backup.yml`                                             |
| `CLOUDFLARE_PREVIEW_INFRA_TOKEN` | environment `preview-infra` (`main` only)  | account-owned token: Account · **Hyperdrive · Edit** (API name `Hyperdrive Write`) only           | `preview.yml` infra, `preview-cleanup.yml` cleanup-infra    |
| `NEON_PREVIEW_API_KEY`           | environments `preview-infra` and `preview` | Neon org key limited to the preview project                                                       | infra, deploy, cleanup-infra                                |
| `CLOUDFLARE_API_TOKEN`           | environment `preview` (`main` only)        | account-owned token: Workers **Editor** on **Specified Workers → `saas-foundation-preview`** only | `preview.yml` deploy, `preview-cleanup.yml` cleanup-preview |

Variables (not secret): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, the `NEON_*` ids.

- **Both Cloudflare tokens are sensitive.** The Hyperdrive token is account-wide (no per-config scope) and could edit production Hyperdrive; the Worker token can deploy a preview bound to any Hyperdrive id, production's included (binding needs no permission on the bound resource). The scripts' guards (ADR-0021 decision 3) and the environments are the fence. No job holds both.
- **Current state (2026-09-29):** all of the above are in place; the repository holds no secrets. Neon organization keys: `saas-foundation-preview-ci` (preview project, both preview environments) and `saas-foundation` (production project, `production`; used by `db-backup.yml`, **keep**).
- **Rotating or recreating preview credentials (owner):**
  1. Cloudflare dashboard → Manage Account → Account API Tokens → _Create token_ → _Custom token_: name `saas-foundation-preview-infra`; permissions **Account · Hyperdrive · Edit**, nothing else; account resources: this account only; no zone permissions, no IP filter. `gh secret set CLOUDFLARE_PREVIEW_INFRA_TOKEN --env preview-infra`.
  2. Neon console → Organization settings → API keys → _Create key_ → _Project-scoped_, project = the preview project, name `saas-foundation-preview-ci`. `gh secret set NEON_PREVIEW_API_KEY --env preview-infra` and `gh secret set NEON_PREVIEW_API_KEY --env preview` (same value).
  3. The per-Worker token (ADR-0019): `gh secret set CLOUDFLARE_API_TOKEN --env preview` (its value, or roll it in the dashboard to get a new one).
  4. Run a PR preview through `preview.yml` / `preview-cleanup.yml`, then revoke the replaced key or token. Never put a preview secret at repo level.
- **Production Neon key:** `saas-foundation`, in `production` as `NEON_API_KEY`; `db-backup.yml` read it successfully on 2026-09-29. It is the only production key; don't revoke it. Production deploys run from the owner's machine (runbook "First production deploy").

## Polar (ADR-0022, ADR-0018, ADR-0020)

Polar is the billing provider and merchant of record: it computes, collects and remits sales tax/VAT and pays the owner out. Not connected yet: unless `BILLING_PROVIDER=polar`, billing actions and the webhook answer 503 (local dev; previews never get a Polar secret, ADR-0021). Set everything up in the **sandbox** first (`POLAR_SERVER=sandbox`), pass the pre-go-live checks below, then repeat steps 1–6 in production (`POLAR_SERVER=production`).

1. Polar organization. Production only: the payout account, in the owner's country of residence.
2. Products: one per sellable price, fixed price (not seat-based), recurring: "Pro monthly" (monthly) and "Pro yearly" (yearly), each with metadata `price_key` = `pro_monthly` / `pro_yearly`, matching `PLANS` in `apps/web/src/modules/billing/policy.ts`. Amounts and currency live only in Polar. Keep exactly one non-archived product per `price_key`; retire a price by archiving its product and marking it `retired` in `policy.ts`. Create no other recurring product (not even a free one): the portal offered the sandbox's `Free (eval)` product as a plan change alongside the Pro ones (2026-09-30), and a `price_key` the policy doesn't know maps to no plan (Free) while Polar keeps the subscription.
3. Customer portal settings: allow cancellation (at period end), switching between the two Pro products, payment method updates and invoices.
4. Organization access token with only the scopes the adapter uses: `customers:write`, `members:write`, `products:read`, `checkouts:write`, `customer_sessions:write`, `subscriptions:read`. A missing scope shows up in step 7 as a Polar permission error.
5. Webhook endpoint `https://<hostname>/api/billing/webhooks/polar`, raw JSON format, every `subscription.*` event (each delivery re-reads the subscription from Polar, so extra ones are harmless; other types are recorded and ignored). Its signing secret becomes `POLAR_WEBHOOK_SECRET`. Polar disables an endpoint whose deliveries keep failing (sandbox, 2026-09-30: the eval endpoints, which can't be reached, were found disabled), and a disabled endpoint receives nothing more; after any outage of the webhook route, check in the dashboard that the endpoint is still enabled, look in its delivery log for deliveries that failed during the outage, and check that each affected organization's Billing page matches its subscription in Polar.
6. Worker secrets (owner), `pnpm --filter web exec wrangler secret put <NAME>` for each: `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_SERVER` (`sandbox` or `production`; unset = sandbox), then `BILLING_PROVIDER` (`polar`) last.
   - In Polar mode without the token, billing actions and subscription webhooks answer 503, and owner removals, demotions and organization deletion are refused (fail closed); without the webhook secret the webhook answers 503.
   - Don't unset `BILLING_PROVIDER` once organizations have Polar customers: owner changes would stop reaching Polar.
7. Check it: as the owner, Billing → Upgrade → the checkout should start at your own country (the app forwards Cloudflare's `cf-connecting-ip`; local dev sends `127.0.0.1`, so none there) → test card (sandbox) → back on Billing, the plan shows Pro once the webhook has arrived; Manage billing opens the Polar portal showing only this organization's subscription.

The adapter itself can also be exercised against the sandbox with `apps/web/eval/polar-provider.test.ts` (not part of `pnpm test`; see its header).

### Before production go-live (sandbox checks, ADR-0022 step 3)

Each check must pass in the sandbox, through a checkout opened by the app, and be recorded here (date and what was observed) in a PR before production is switched to Polar. Webhook deliveries need the endpoint reachable from Polar; Polar's delivery log shows each event.

- [ ] **Billing country:** the checkout starts with no country or the buyer's, never an unrelated default; the country the buyer picks is what Polar stores (customer billing address) and what the invoice shows. 2026-09-29 (sandbox): checkouts opened by the app without the buyer's IP started with no country; the app now forwards Cloudflare's `cf-connecting-ip` as `customer_ip_address`, and checkouts opened through the adapter (sandbox eval, IP supplied by the harness) with a Peruvian IP started prefilled `PE` (direct API probes: `8.8.8.8` → `US`, `127.0.0.1` → none, accepted). Kept as prefilled, the paid order stored `PE`; changed to Chile on Polar's page, the paid order stored `CL` and the invoice billed to Chile. The eval runs' earlier `AO`, `AR` and `PE` were likewise the buyer's deliberate picks, each stored and invoiced as picked. Remaining: the same through the deployed app (step 7): the checkout starts at the buyer's country; then tick this.
- [ ] **Plan change:** switching `pro_monthly` ↔ `pro_yearly` in the portal produces `subscription.updated` events that link to the organization and map to the new `price_key`, with Polar's proration. 2026-09-30 (sandbox, eval run `r11-0929`, adapter checkout, trial ended early with `POLAR_EVAL_PAID=endtrial`, then charged $29 as `active`): switching in the portal from `pro_monthly` to `pro_yearly` ($290/year) sent `subscription.updated` carrying `pro_yearly`, linked, re-read as `active`/`pro_yearly` with the period end moved a year out; Two earlier switches, through a mistaken `pro_yearly` product with a monthly interval (since archived) and back to `pro_monthly`, each sent a linked `subscription.updated` with the new `price_key` and made no order of their own. Polar then charged at once one `subscription_update` order of $261.02 with proration lines for all three switches: +$290.00 (the year), −$28.99 and +$28.99 and −$28.99 (monthly time), +$289.92 and −$289.91 (the mistaken product). Switching back from `pro_yearly` to `pro_monthly` sent `subscription.updated` carrying `pro_monthly`, linked, re-read as `active`/`pro_monthly` with a monthly period from the switch, and Polar recorded a `subscription_update` order of −$260.99 (−$289.99 for the unused year, +$29.00 for the month). Remaining: the same through the deployed app (step 7), where events are applied; then tick this.
- [ ] **Failed renewal:** a subscription whose renewal is charged to a failing test card goes `past_due` (plan kept, ADR-0020) and then `unpaid` or `canceled` (Free), each event linked and applied. 2026-09-30 (sandbox, eval run `r13-0929`, adapter checkout paid with Stripe's `4000 0000 0000 0341`, which Polar's checkout accepted): trial end moved to 02:49:46Z (`POLAR_EVAL_PAID=endtrial`); the charge failed and Polar sent `subscription.updated` (sent as `active`), then `subscription.updated` and `subscription.past_due` (sent as `past_due`); every event linked and, re-read by the parser, mapped to `past_due` (plan kept, `ENTITLED` in `policy.ts`), next period end 2026-10-30. Remaining: the end of Polar's retries (2, 7, 14 and 21 days after the failure, then canceled; sooner on a permanent decline), expected around 2026-10-21 (`POLAR_EVAL_PAID=events` on `r13-0929`; if Polar has disabled its endpoint by then, see step 5, the subscription's state shows the outcome but not the events); then the same through the deployed app (step 7): each event delivered successfully and the Billing page showing Pro while `past_due`, then Free; then tick this.
- [ ] **Cancellation at period end:** cancelling in the portal keeps `active` with `cancel_at_period_end` until the period ends, then Free. 2026-09-30 (sandbox, eval run `r12-0929`, trialing adapter checkout): cancelling in the portal at 02:43Z sent `subscription.updated` and `subscription.canceled` right away, both sent and re-read as `trialing` with `cancel_at_period_end: true` (plan kept); `subscription.canceled` doesn't mean the plan ended, and the parser applies the re-read status, not the event type. With the period end brought forward to 02:54:05Z (`POLAR_EVAL_PAID=endtrial`), Polar sent `subscription.updated`, `subscription.canceled` and `subscription.revoked`, sent and re-read as `canceled` (Free). Every event linked to the organization (`POLAR_EVAL_PAID=events`). This was a trialing subscription; remaining: the same through the deployed app (step 7) on an `active` (paid) subscription, the Billing page showing Pro until the period ends, then Free; then tick this.

## Database (ADR-0003, Neon Free)

- Restore within 6 h: Neon point-in-time restore of `main`.
- Restore from a daily snapshot (ADR-0003 option A; `backup-YYYYMMDD`, newest 3 kept). Snapshots are **child branches** of `main`, and Neon's `branches restore` only works between root branches, so **don't use `neon branches restore`**. Procedure tested end to end on the preview project (2026-09-28). Auth: `neon auth` (or `NEON_API_KEY`); set `export NEON_PROJECT_ID=flat-cherry-23373668` and pass `--project-id "$NEON_PROJECT_ID"` to every command.
  1. **Inspect:** `neon branches add-compute backup-YYYYMMDD --type read_only --project-id "$NEON_PROJECT_ID"`, then `neon connection-string backup-YYYYMMDD --project-id "$NEON_PROJECT_ID"` and query it (e.g. `docker run --rm postgres:17-alpine psql "<url>"`).
  2. **Selective recovery** (preferred; keeps newer writes): `docker run --rm postgres:17-alpine pg_dump "<backup url>" --data-only --table=<t>` piped into `psql "<main url>"`. Resolve conflicts manually.
  3. **Full rollback ("promote"; loses writes made after the snapshot):**
     - `neon branches add-compute backup-YYYYMMDD --type read_write --project-id "$NEON_PROJECT_ID"`
     - `neon branches rename main main-before-restore-YYYYMMDD --project-id "$NEON_PROJECT_ID"`, then `neon branches rename backup-YYYYMMDD main --project-id "$NEON_PROJECT_ID"`, then `neon branches set-default main --project-id "$NEON_PROJECT_ID"`
     - `wrangler hyperdrive update <prod-hyperdrive-id> --connection-string="$(neon connection-string main --project-id "$NEON_PROJECT_ID" --database-name app --role-name app_owner)"` (caching stays disabled; the id and binding are unchanged, so no redeploy)
     - **Restart the Hyperdrive pool:** an update doesn't tear down existing pooled connections, which would keep using the old branch. `curl -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/hyperdrive/configs/<prod-hyperdrive-id>/restart"` (Cloudflare API "Restart Hyperdrive"; `<prod-hyperdrive-id>` is the `DB` id in `apps/web/wrangler.jsonc`), or the dashboard: Hyperdrive → `saas-foundation-prod` → Settings → Danger zone → **Restart**. In-flight queries may briefly error.
     - verify `/api/health`. `main-before-restore-*` **can't be deleted**: it's the parent of the new `main` and of the older snapshots, and Neon forbids deleting branches that have children. Each promote therefore permanently uses one of the 10 branch slots, so treat promote as a last resort and prefer selective recovery. Snapshots keep working because the new production branch is named `main` again.
- Neon's snapshot feature (one-step restore that keeps the connection string) is limited on Free to **1 manual snapshot, no schedules**. Registered as a possible complement, not adopted.
- Snapshots run daily (`db-backup.yml`); run by hand with `gh workflow run db-backup.yml`.
- Drill on the production project, 2026-09-28 (ADR-0019), using exactly the commands above:
  - marker in `main` → snapshot branch (`--no-compute`) → change `main`;
  - read-only compute on the snapshot: pre-change state, writes refused;
  - branch restored from the snapshot: same state, writable;
  - cleaned up afterwards. Repeat it (with a `drill-*` name, so the `backup-*` rotation isn't touched) after changing this procedure.
- Watch: monthly CU-hours (compute is suspended when exceeded) and the 0.5 GB storage ceiling.

## First production deploy (owner sequence, 2026-09-28)

First deployed 2026-09-30 (milestone A, from `29ce6da`, Worker version `25fc77e3-28a8-4eba-92b3-f902f1b14d91`); steps 0–8 are done, 9–11 (milestone B) are open. Steps marked **owner** need credentials, accounts or dashboard access. Don't skip or reorder.

**Data gate (ADR-0014):** until off-provider backup option B is implemented **and** a restore from it has been tested, production holds **only synthetic smoke-test accounts**, never real customer data. Sign-up is enforced in code: with `SIGNUP_MODE` unset (the production default), sign-up is **closed** except for the exact addresses in `SIGNUP_ALLOWLIST`.

- **Before step 7:** `pnpm --filter web exec wrangler secret put SIGNUP_ALLOWLIST` with the comma-separated smoke-test addresses. Don't set `SIGNUP_MODE` in production.
  - _Done 2026-09-30: two plus-addresses of the owner's own mailbox (real MX, so they also work as Polar sandbox customers; never a public inbox such as Mailinator, whose messages anyone can read). `SIGNUP_MODE` unset._

**Launch milestones (owner, 2026-09-29).** Four separate gates, in order. C and D are separate decisions, each recorded in its own ADR; lifting the data gate does **not** open sign-up.

- **A. Technically deployed:** production DB migrated, Worker deployed (steps 0–7). Sign-up allowlisted to smoke-test addresses; no real customer data, no Polar production mode, no public sign-up.
- **B. Internal production smoke complete:** smoke test passed (step 8), WAF rule applied and tested (steps 9–10), the previous broad Cloudflare user token confirmed revoked (step 11). Still no real customer data.
- **C. Real customer data, sign-up still allowlisted:** backup option B implemented and a restore from it tested (ADR-0014), alerting operational (ADR-0015), email delivery live and email verification enforced (ADR-0016), smoke-test accounts removed, and a new ADR lifting the data gate. Then, after deleting the smoke-test accounts, `pnpm --filter web exec wrangler secret put SIGNUP_ALLOWLIST` with only the admitted customers' addresses (no smoke-test address left in it), and keep `SIGNUP_MODE` unset.
- **D. Public sign-up (`SIGNUP_MODE=open`):** its own ADR, after C, covering a bot-protection decision (Turnstile, ADR-0005), the WAF rule live, legal pages (privacy, terms, subprocessors), and Neon Free's capacity limits (ADR-0003) explicitly accepted or the plan upgraded.
- Polar production mode (section "Polar") needs C first, since paying customers are real data, and its sandbox checks passed.

0. **Preflight:** a clean checkout of `main` at the commit to deploy, Node 24 (`.node-version`), then `pnpm install --frozen-lockfile` (pnpm version from `packageManager`). `pnpm check && pnpm test` pass.
   - _Done 2026-09-30 at `29ce6da`, in a separate detached worktree (`git worktree add --detach <path> origin/main`, no `.dev.vars`): `pnpm check` passed, `pnpm test` 185 passed. Not the main checkout: ESLint also lints git-ignored worktrees nested under `.claude/worktrees/`, which failed `pnpm check` there._

1. **GitHub `production` environment:** exists, restricted to deployment branch `main` (ADR-0013; this repo's environment secrets and branch rules were verified to work). Required reviewers aren't available on this plan, so the human gate is the owner running the deploy by hand (step 7). **Before launch:**
   - `NEON_API_KEY` (production-project-scoped Neon key) is set in `production` (section "CI credentials");
   - a dispatched backup run with that key succeeded: `gh workflow run db-backup.yml`. The script always lists the project's branches with the key first, so success proves the key authenticates; a project-scoped key has full rights inside its project. If today's `backup-YYYYMMDD` already existed, no new branch is created, and tomorrow's scheduled run must show a new one;
   - the repo-level `NEON_API_KEY` is gone.
   - _All three done 2026-09-29 (section "CI credentials")._
2. **Owner:** production `BETTER_AUTH_SECRET`: `openssl rand -base64 32 | pnpm --filter web exec wrangler secret put BETTER_AUTH_SECRET` (never pasted into chat, never committed).
   - _Done 2026-09-30 04:04Z. The Worker didn't exist yet, so `wrangler secret put` (stdin not a terminal) created a draft Worker `saas-foundation` with a placeholder script and no routes, then stored the secret; step 7 replaced the script. `wrangler secret list` showed the name only._
3. **Owner:** production `BETTER_AUTH_URL` = `https://<production hostname>`, i.e. the custom-domain `routes` pattern in `apps/web/wrangler.jsonc` (ADR-0017), set with `wrangler secret put` (or as a var).
   - _Done 2026-09-30 (`echo https://app.aaronlabr.dev | … wrangler secret put BETTER_AUTH_URL`; wrangler trims the trailing newline of piped input). Listed with `BETTER_AUTH_SECRET` and `SIGNUP_ALLOWLIST`._
4. Custom domain: the production hostname is configured in `wrangler.jsonc` (`routes[].custom_domain`). Cloudflare creates its DNS record and certificate on the first deploy. The production zone is already active in the account. Production Hyperdrive `saas-foundation-prod`: **done 2026-09-28** (ADR-0019), id in `wrangler.jsonc`. To re-verify without deploying: build, copy `apps/web/dist` somewhere without `.dev.vars` (the build copies it into `dist/server/`), drop `routes` from the copy's `dist/server/wrangler.json`, run `wrangler dev --remote --config dist/server/wrangler.json --ip 127.0.0.1`, and send exactly one request, `GET /api/health`, expecting `{"ok":true,"db":"up"}`. That route only runs `SELECT 1`. The session runs the whole app against production data, so send nothing else and stop it immediately. Stop the session by the parent PID of its `workerd` (ss -ltnp), since `workerd` respawns otherwise.
   - _Re-verified 2026-09-30 before migrating: one `GET /api/health` returned `{"ok":true,"db":"up"}`; session stopped as described._
5. Observability: `observability.enabled` is on in `apps/web/wrangler.jsonc`. After the deploy (step 7), check that requests show up in the dashboard (Workers & Pages → `saas-foundation` → Logs) or live with `pnpm --filter web exec wrangler tail saas-foundation --format pretty`. Logs must contain no secrets or PII (ADR-0015). The alerting requirement from ADR-0015 must be met before milestone C (real customer data).
   - _Done 2026-09-30 with `wrangler tail` during step 8: every request showed up (method, URL, outcome); the only log lines were `better_auth` warnings (`User not found`, `Invalid password`) and `email.delivery_disabled` (`kind: verification`); no emails, bodies, cookies or tokens; server-function paths show as `REDACTED`. A tail opened seconds before a request can miss it. Within minutes of the first deploy, scanners requested `/.env` and `/.git/HEAD`; both reached the app's 404 (the static assets are only `assets/`)._
6. **Restore point, then migrations.**
   - Take a restore point **synchronously, right before migrating**. Don't rely on `db-backup.yml`: it's asynchronous and skips if today's `backup-YYYYMMDD` already exists. Instead run `pnpm exec neon branches create --project-id flat-cherry-23373668 --name "pre-migrate-$(date -u +%Y%m%d-%H%M)" --parent main --no-compute` and check it appears in `pnpm exec neon branches list --project-id flat-cherry-23373668` with a creation time from just now. Delete it once the release is verified; it uses one of Neon Free's 10 branches. _2026-09-30: `pre-migrate-20260930-0415` created at 04:15:13Z (listed, `ready`), deleted after step 8._ On Neon Free, PITR only reaches back 6 h.
   - Migrate: `DATABASE_URL="$(pnpm exec neon connection-string main --project-id flat-cherry-23373668 --database-name app --role-name app_owner)" pnpm db:migrate`. Direct (non-pooler) URL, never printed or logged.
   - Pending now (the database is empty): `0000` (slice schema), `0001` (`rate_limit`), `0002` (billing tables), `0003` (the subscription-id unique constraint becomes unique per provider), `0004` (the billing subscription's organization foreign key is dropped and re-added with `ON DELETE CASCADE`, ADR-0020). They create tables or replace constraints; none drops a column or data.
   - _Done 2026-09-30: `drizzle.__drizzle_migrations` has 5 rows whose `created_at` equal the `when` of `0000`–`0004` in `packages/db/drizzle/meta/_journal.json`. The migrate ran from the owner's main checkout at the same commit as step 0._
7. First deploy: `pnpm run deploy` (not `pnpm deploy`, which is a pnpm built-in) from the step 0 checkout, using the owner's logged-in `wrangler`. The deploy itself uses the owner's local credentials, not CI; no CI credential can deploy the production Worker (runbook "CI credentials"). Only the production-project Neon key (`production` environment) reaches the production database directly; the two preview Cloudflare tokens can still reach production data indirectly (the Worker token can bind production Hyperdrive, the Hyperdrive token can edit it; ADR-0021, section "CI credentials").
   - _Done 2026-09-30 from the step 0 worktree: `app.aaronlabr.dev (custom domain)`, version `25fc77e3-28a8-4eba-92b3-f902f1b14d91`. `/api/health` over HTTPS answered `{"ok":true,"db":"up"}` with a valid certificate. Open: plain `http://app.aaronlabr.dev/` is served, not redirected; enabling the zone's **Always Use HTTPS** is proposed (owner's decision)._
8. Smoke test on the custom domain:
   - `/api/health` returns `ok`
   - sign-up, login, create an organization
   - invitation and password-reset emails, if delivery is activated (ADR-0016, "Activation")
   - login rate limit: 6 wrong-password POSTs to `/api/auth/sign-in/email` from one IP within 60 s; the 6th returns **429**
   - _Done 2026-09-30 (owner, browser; `wrangler tail` alongside): `/api/health` ok; sign-up with an allowlisted address, sign-out and sign-in, organization created; a non-allowlisted address was refused; emails skipped (delivery not activated, one `email.delivery_disabled` log at sign-up). Rate limit: 6 wrong-password sign-ins at 04:31:16–22Z; the first 5 logged `Invalid password`, the 6th logged nothing and the page showed "Too many requests. Please try again later." (the status code itself wasn't captured)._
9. **Owner:** add the WAF rule `auth-login-burst` (ADR-0014).
10. Smoke-test the WAF on its own: more than 10 POSTs to `/api/auth/sign-in/email` within 10 s from one IP are blocked at the edge (Cloudflare block page, visible in Security → Events). Wait 60 s so the app's own limit resets, and check that a normal login still works.
11. **Owner:** confirm the previous broad Cloudflare user token (the old CI token, which could deploy any Worker) is revoked: dashboard → My Profile → API Tokens. CI no longer uses it (ADR-0019, ADR-0021), but only revocation removes its reach. This completes milestone B.

Rollback: `wrangler rollback` to the previous Worker version (code only). Migrations are forward-only (expand → migrate → contract). For data, use the Database section below.

Planned: routine deploys, migrations after launch.
