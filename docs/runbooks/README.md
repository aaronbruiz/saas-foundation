# Runbooks

## Previews (ADR-0011)

- Create/update by hand: `PR_NUMBER=<n> scripts/preview/up.sh` (needs the env vars from `.github/workflows/ci.yml`).
- Trusted deploy of a build artifact (ADR-0013 step 3; CI switches to it next): from a checkout of the PR's **base** commit, `PR_NUMBER=<n> ARTIFACT_DIR=<dir> scripts/preview/deploy-artifact.sh`. `<dir>` holds `apps/web/dist` and `packages/db/drizzle` from the PR's build; the script runs none of the PR's code. It validates and patches `dist/server/wrangler.json` (`prepare-config.mjs`), migrates with `packages/db/scripts/migrate.mjs`, and deploys with `--config`. A refused config lists each reason; a legitimate new key or binding needs the validator updated on `main` first.
- By hand with the logged-in sessions instead of CI secrets: `CLOUDFLARE_API_TOKEN="$(pnpm --dir apps/web exec wrangler auth token | tail -1)"` and `NEON_API_KEY` from `~/.config/neon/credentials.json` (`access_token`; it expires quickly, so run any `neonctl` command without `--api-key` first to refresh it), plus the CI vars. Tested 2026-09-28 as PR 9001: deploy, re-deploy, E2E, `down.sh`.
- Delete: `PR_NUMBER=<n> scripts/preview/down.sh`. Orphans: `scripts/preview/janitor.sh` (runs daily in CI).
- Known issue (Previews open beta, 2026-09-27): a Preview URL can keep serving after a successful `wrangler preview delete` (seen on pr-4 and pr-5; pr-3 returned 404). `down.sh` therefore deletes the Neon branch and Hyperdrive config **before** the preview, so a lingering URL serves code only (`db: down`). It then checks the URL and raises a warning. Report upstream if it persists.
- "preview slots exhausted": 9 PR previews max (Neon Free: 10 branches per project). Close PRs or run the janitor.

### If a preview credential leaks

Preview branches inherit `app_owner`'s password from `preview-seed`, so one leak exposes every preview branch (synthetic data only; production is a separate project with its own password).

1. Delete the leaking artifact (comment, log, file).
2. `PR_NUMBER=<n> scripts/preview/down.sh` for the affected PRs.
3. Reset `app_owner`'s password on `preview-seed` (Neon API `POST …/branches/<preview-seed>/roles/app_owner/reset_password`).
4. Re-run the PR's CI to recreate the preview with the new password.

Incident 2026-09-27 (PR #4): `up.sh`'s stdout was captured into the step output. The `::add-mask::` command was never executed, the preview connection string was posted in the PR comment, and the capture also **hid `up.sh`'s failure** (the step reported success). Fixed: `up.sh` writes `$GITHUB_OUTPUT` itself, and URL-shape guards run in the script and in the workflow. Steps 1–3 above were done.

## Observability (ADR-0015)

Where to look when production fails:

- **Dashboard:** Workers & Pages → `saas-foundation` → Observability (Logs / Events). Filter by `level = error`, by `event` (`server_fn.unhandled`, `health.db_down`, `better_auth`), or by `rayId`.
  - A user-reported Cloudflare ray id (shown on Cloudflare error pages) matches `rayId`.
  - Each request's invocation log shows its status and outcome.
- **Live:** `pnpm --filter web exec wrangler tail saas-foundation --format pretty --search '"level":"error"'`. Don't rely on `--status error`: it filters on the invocation's outcome, and server-function failures are turned into responses, so those invocations end `ok`.
- **Health:** `curl -s https://<domain>/api/health` returns `{ ok, db }`. A `503` means the database is unreachable; the reason is in the `health.db_down` event.
- **Retention:** 7 days (Workers Paid). Copy anything needed longer into the incident notes, without PII.
- **Never** paste log lines containing user data into tickets or chat. The logger redacts emails and URL credentials; check anything you copy.

## CI credentials (ADR-0019)

| Secret                 | Where                                         | Scope                                                                                             | Used by                     |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| `NEON_API_KEY`         | environment `production` (branch `main` only) | Neon org key limited to the production project                                                    | `db-backup.yml`             |
| `NEON_PREVIEW_API_KEY` | repo                                          | Neon org key limited to the preview project                                                       | preview deploy/cleanup (T1) |
| `CLOUDFLARE_API_TOKEN` | repo                                          | account-owned token: Workers **Editor** on **Specified Workers → `saas-foundation-preview`** only | preview deploy/cleanup (T1) |

Variables (not secret): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, `PREVIEW_HYPERDRIVE_SLOTS`, the `NEON_*` ids.

- **Production Neon key (owner), in this order** (a repo-level secret with the same name would otherwise answer for the environment and make the check meaningless):
  1. `gh secret delete NEON_API_KEY` (the repo-level copy);
  2. Neon console → Organization settings → API keys → _Create key_ → _Project-scoped_, project = the production project, name `saas-foundation-production-ci`;
  3. `gh secret set NEON_API_KEY --env production` (paste at the prompt; nothing is echoed);
  4. `gh workflow run db-backup.yml` and see the run succeed;
  5. revoke the unused older production-scoped key and the personal key in the Neon console.
- **Preview Cloudflare token (owner):** dashboard → Manage Account → Account API Tokens → _Create token_ → Workers → role **Editor**, scope **Specified Workers**: `saas-foundation-preview`. No other permissions. `gh secret set CLOUDFLARE_API_TOKEN` (paste at the prompt), then revoke the old user token. Check it: re-run a PR's preview job. The deploy step logs "account-owned token → active".
- **After** the rollout in ADR-0019 (slots in use, token replaced, old token revoked), the preview credentials can't deploy the production Worker or touch production Hyperdrive (the backup key reaches the production Neon project by design, fenced by the environment). **Until then** CI's `CLOUDFLARE_API_TOKEN` is the old account-wide token, and the repo-level `NEON_API_KEY` stays readable by PR workflows until it's deleted. Production deploys run from the owner's machine (runbook "First production deploy").

## Database (ADR-0003, Neon Free)

- Restore within 6 h: Neon point-in-time restore of `main`.
- Restore from a daily snapshot (ADR-0003 option A; `backup-YYYYMMDD`, newest 3 kept). Snapshots are **child branches** of `main`, and Neon's `branches restore` only works between root branches, so **don't use `neonctl branches restore`**. Procedure tested end to end on the preview project (2026-09-28). Auth: `neonctl auth` (or `NEON_API_KEY`); set `export NEON_PROJECT_ID=flat-cherry-23373668` and pass `--project-id "$NEON_PROJECT_ID"` to every command.
  1. **Inspect:** `neonctl branches add-compute backup-YYYYMMDD --type read_only --project-id "$NEON_PROJECT_ID"`, then `neonctl connection-string backup-YYYYMMDD --project-id "$NEON_PROJECT_ID"` and query it (e.g. `docker run --rm postgres:17-alpine psql "<url>"`).
  2. **Selective recovery** (preferred; keeps newer writes): `docker run --rm postgres:17-alpine pg_dump "<backup url>" --data-only --table=<t>` piped into `psql "<main url>"`. Resolve conflicts manually.
  3. **Full rollback ("promote"; loses writes made after the snapshot):**
     - `neonctl branches add-compute backup-YYYYMMDD --type read_write --project-id "$NEON_PROJECT_ID"`
     - `neonctl branches rename main main-before-restore-YYYYMMDD --project-id "$NEON_PROJECT_ID"`, then `neonctl branches rename backup-YYYYMMDD main --project-id "$NEON_PROJECT_ID"`, then `neonctl branches set-default main --project-id "$NEON_PROJECT_ID"`
     - `wrangler hyperdrive update <prod-hyperdrive-id> --connection-string="$(neonctl connection-string main --project-id "$NEON_PROJECT_ID" --database-name app --role-name app_owner)"` (caching stays disabled; the id and binding are unchanged, so no redeploy)
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
   - Take a restore point **synchronously, right before migrating**. Don't rely on `db-backup.yml`: it's asynchronous and skips if today's `backup-YYYYMMDD` already exists. Instead run `pnpm exec neonctl branches create --project-id flat-cherry-23373668 --name "pre-migrate-$(date -u +%Y%m%d-%H%M)" --parent main --no-compute` and check it appears in `pnpm exec neonctl branches list --project-id flat-cherry-23373668` with a creation time from just now. Delete it once the release is verified; it uses one of Neon Free's 10 branches. On Neon Free, PITR only reaches back 6 h.
   - Migrate: `DATABASE_URL="$(pnpm exec neonctl connection-string main --project-id flat-cherry-23373668 --database-name app --role-name app_owner)" pnpm db:migrate`. Direct (non-pooler) URL, never printed or logged.
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
