# Runbooks

## Previews (ADR-0021)

**Invariant:** preview resources are created and removed by CI. Normal preview lifecycle operations (create, reset, deploy, revoke) require no human intervention. Manual operations are administrative or recovery procedures only.

- **Per PR:** Neon branch `preview/pr-<N>` (child of `preview-seed` in the preview project, its own `app_owner` password) and Hyperdrive config `saas-pr-<N>` (caching off). Hyperdrive ids are never reused: a closed PR's config is deleted, a reopened PR gets a new one. **Deleting the config is what revokes database access.** A 404 from a deleted Preview URL is not: deleted Previews and their deployment URLs can keep executing (Cloudflare Previews beta).
- **Flow** (`.github/workflows/preview.yml`, `workflow_run` after CI; default-branch code only):
  - `resolve`: the one open same-repo PR whose head is the CI run's commit;
  - `infra` (environment `preview-infra`): `scripts/preview/infra.sh up` creates the branch, or resets its data to the seed, and creates or reuses the guarded config; never sees the artifact;
  - `deploy` (environment `preview`): `scripts/preview/deploy-artifact.sh` validates the artifact (`apps/web/dist` + `packages/db/drizzle` from CI), migrates with the default-branch migrator, patches the config to that id (`prepare-config.mjs`) and runs `wrangler preview`. A refused config lists each reason; a legitimate new key or binding needs the validator updated on `main` first;
  - `e2e`: the default-branch Playwright suite against the URL, then a PR comment.
- **Close** (`preview-cleanup.yml`, `pull_request_target`): `cleanup-preview` runs `scripts/preview/down.sh` (deletes the Preview), then `cleanup-infra` runs `scripts/preview/infra.sh down` (deletes the config, then the branch). Both act only on a PR that GitHub reports closed right now. A preview run and close-triggered cleanup of one PR hold the same lock (`preview-pr-N`, whole workflow, queued, never cancelled), so cleanup waits for a running preview, E2E included; the janitor skips PRs whose preview run is still active. **Daily janitor:** `janitor.sh` and `infra.sh janitor` do the same for closed PRs a run missed.
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

## Stripe (ADR-0018, ADR-0020)

Not connected yet: without the secrets below, the billing actions and the webhook answer 503. To go live (test mode first):

1. Stripe dashboard → Product "Pro" with two recurring prices (USD in the reference setup) whose **lookup keys** are `pro_monthly` and `pro_yearly`, matching `PLANS` in `apps/web/src/modules/billing/policy.ts`. Amounts live only in Stripe.
2. Customer portal settings: allow cancel (at period end), switching between those two prices, payment method updates and invoice history.
3. Stripe Tax: activate it and add registrations. `CHECKOUT.automaticTax` is on, so Checkout fails without it.
4. Webhook endpoint `https://<production hostname>/api/billing/webhooks/stripe`, events `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `.trial_will_end`.
5. Worker secrets (owner): `pnpm --filter web exec wrangler secret put STRIPE_SECRET_KEY` (a restricted key with write access to Checkout Sessions and Customer Portal sessions and read access to Prices is enough), and `… STRIPE_WEBHOOK_SECRET` (the endpoint's signing secret).
6. Check it: as the owner, Billing → Upgrade → Stripe test card → back on Billing, the plan shows Pro; then Manage billing → cancel → at period end the plan returns to Free.

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

Never deployed yet. Steps marked **owner** need credentials, accounts or dashboard access. Don't skip or reorder.

**Data gate (ADR-0014):** until off-provider backup option B is implemented **and** a restore from it has been tested, production holds **only synthetic smoke-test accounts**, never real customer data. It's enforced in code: with `SIGNUP_MODE` unset (the production default), sign-up is **closed** except for the exact addresses in `SIGNUP_ALLOWLIST`.

- **Before step 7:** `pnpm --filter web exec wrangler secret put SIGNUP_ALLOWLIST` with the comma-separated smoke-test addresses. Don't set `SIGNUP_MODE` in production.
- Lifting the gate (`SIGNUP_MODE=open`) is an owner decision recorded in a new ADR.
- Remove the smoke-test accounts before real users arrive.

0. **Preflight:** a clean checkout of `main` at the commit to deploy, Node 24 (`.node-version`), then `pnpm install --frozen-lockfile` (pnpm version from `packageManager`). `pnpm check && pnpm test` pass.

1. **GitHub `production` environment:** exists, restricted to deployment branch `main` (ADR-0013; this repo's environment secrets and branch rules were verified to work). Required reviewers aren't available on this plan, so the human gate is the owner running the deploy by hand (step 7). **Before launch:**
   - `NEON_API_KEY` (production-project-scoped Neon key) is set in `production` (section "CI credentials");
   - a dispatched backup run with that key succeeded: `gh workflow run db-backup.yml`. The script always lists the project's branches with the key first, so success proves the key authenticates; a project-scoped key has full rights inside its project. If today's `backup-YYYYMMDD` already existed, no new branch is created, and tomorrow's scheduled run must show a new one;
   - the repo-level `NEON_API_KEY` is gone.
2. **Owner:** production `BETTER_AUTH_SECRET`: `openssl rand -base64 32 | pnpm --filter web exec wrangler secret put BETTER_AUTH_SECRET` (never pasted into chat, never committed).
3. **Owner:** production `BETTER_AUTH_URL` = `https://<production hostname>`, i.e. the custom-domain `routes` pattern in `apps/web/wrangler.jsonc` (ADR-0017), set with `wrangler secret put` (or as a var).
4. Custom domain: the production hostname is configured in `wrangler.jsonc` (`routes[].custom_domain`). Cloudflare creates its DNS record and certificate on the first deploy. The production zone is already active in the account. Production Hyperdrive `saas-foundation-prod`: **done 2026-09-28** (ADR-0019), id in `wrangler.jsonc`. To re-verify without deploying: build, copy `apps/web/dist` somewhere without `.dev.vars` (the build copies it into `dist/server/`), drop `routes` from the copy's `dist/server/wrangler.json`, run `wrangler dev --remote --config dist/server/wrangler.json --ip 127.0.0.1`, and send exactly one request, `GET /api/health`, expecting `{"ok":true,"db":"up"}`. That route only runs `SELECT 1`. The session runs the whole app against production data, so send nothing else and stop it immediately. Stop the session by the parent PID of its `workerd` (ss -ltnp), since `workerd` respawns otherwise.
5. Observability: `observability.enabled` is on in `apps/web/wrangler.jsonc`. After the deploy (step 7), check that requests show up in the dashboard (Workers & Pages → `saas-foundation` → Logs) or live with `pnpm --filter web exec wrangler tail saas-foundation --format pretty`. Logs must contain no secrets or PII (ADR-0015). Also set up the alerting requirement from ADR-0015 before the data gate is lifted.
6. **Restore point, then migrations.**
   - Take a restore point **synchronously, right before migrating**. Don't rely on `db-backup.yml`: it's asynchronous and skips if today's `backup-YYYYMMDD` already exists. Instead run `pnpm exec neon branches create --project-id flat-cherry-23373668 --name "pre-migrate-$(date -u +%Y%m%d-%H%M)" --parent main --no-compute` and check it appears in `pnpm exec neon branches list --project-id flat-cherry-23373668` with a creation time from just now. Delete it once the release is verified; it uses one of Neon Free's 10 branches. On Neon Free, PITR only reaches back 6 h.
   - Migrate: `DATABASE_URL="$(pnpm exec neon connection-string main --project-id flat-cherry-23373668 --database-name app --role-name app_owner)" pnpm db:migrate`. Direct (non-pooler) URL, never printed or logged.
   - Pending now: `0000` (slice schema), `0001` (`rate_limit`), `0002`–`0003` (billing); all only create tables or relax a constraint.
7. First deploy: `pnpm run deploy` (not `pnpm deploy`, which is a pnpm built-in) from the step 0 checkout, using the owner's logged-in `wrangler`. The deploy itself uses the owner's local credentials, not CI. CI's production-capable credentials (ADR-0019): only the production-project Neon key, fenced by the `production` environment. Until the owner replaces `CLOUDFLARE_API_TOKEN` with the per-Worker preview token, the old token could also deploy production.
8. Smoke test on the custom domain:
   - `/api/health` returns `ok`
   - sign-up, login, create an organization
   - invitation and password-reset emails, if delivery is activated (ADR-0016, "Activation")
   - login rate limit: 6 wrong-password POSTs to `/api/auth/sign-in/email` from one IP within 60 s; the 6th returns **429**
9. **Owner:** add the WAF rule `auth-login-burst` (ADR-0014).
10. Smoke-test the WAF on its own: more than 10 POSTs to `/api/auth/sign-in/email` within 10 s from one IP are blocked at the edge (Cloudflare block page, visible in Security → Events). Wait 60 s so the app's own limit resets, and check that a normal login still works.

Rollback: `wrangler rollback` to the previous Worker version (code only). Migrations are forward-only (expand → migrate → contract). For data, use the Database section below.

Planned: routine deploys, migrations after launch.

<!-- preview lock validation, 2026-09-29; closed without merging -->
