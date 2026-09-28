# Runbooks

## Previews (ADR-0011)

- Create/update by hand: `PR_NUMBER=<n> scripts/preview/up.sh` (needs the env vars from `.github/workflows/ci.yml`).
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

## Database (ADR-0003, Neon Free)

- Restore within 6 h: Neon point-in-time restore of `main`.
- Restore from a daily snapshot (ADR-0003 option A; `backup-YYYYMMDD`, newest 3 kept). Snapshots are **child branches** of `main`, and Neon's `branches restore` only works between root branches, so **don't use `neonctl branches restore`**. Procedure tested end to end on the preview project (2026-09-28). Auth: `neonctl auth` (or `NEON_API_KEY`); set `export NEON_PROJECT_ID=flat-cherry-23373668` and pass `--project-id "$NEON_PROJECT_ID"` to every command.
  1. **Inspect:** `neonctl branches add-compute backup-YYYYMMDD --type read_only --project-id "$NEON_PROJECT_ID"`, then `neonctl connection-string backup-YYYYMMDD --project-id "$NEON_PROJECT_ID"` and query it (e.g. `docker run --rm postgres:17-alpine psql "<url>"`).
  2. **Selective recovery** (preferred; keeps newer writes): `docker run --rm postgres:17-alpine pg_dump "<backup url>" --data-only --table=<t>` piped into `psql "<main url>"`. Resolve conflicts manually.
  3. **Full rollback ("promote"; loses writes made after the snapshot):**
     - `neonctl branches add-compute backup-YYYYMMDD --type read_write --project-id "$NEON_PROJECT_ID"`
     - `neonctl branches rename main main-before-restore-YYYYMMDD --project-id "$NEON_PROJECT_ID"`, then `neonctl branches rename backup-YYYYMMDD main --project-id "$NEON_PROJECT_ID"`, then `neonctl branches set-default main --project-id "$NEON_PROJECT_ID"`
     - `wrangler hyperdrive update 29b70e89b57945e1875c0a030b377243 --connection-string="$(neonctl connection-string main --project-id "$NEON_PROJECT_ID" --database-name app --role-name app_owner)"` (caching stays disabled; the id and binding are unchanged, so no redeploy)
     - **Restart the Hyperdrive pool:** an update doesn't tear down existing pooled connections, which would keep using the old branch. `curl -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/hyperdrive/configs/29b70e89b57945e1875c0a030b377243/restart"` (Cloudflare API "Restart Hyperdrive"), or the dashboard: Hyperdrive → `saas-foundation-prod` → Settings → Danger zone → **Restart**. In-flight queries may briefly error.
     - verify `/api/health`. `main-before-restore-*` **can't be deleted**: it's the parent of the new `main` and of the older snapshots, and Neon forbids deleting branches that have children. Each promote therefore permanently uses one of the 10 branch slots, so treat promote as a last resort and prefer selective recovery. Snapshots keep working because the new production branch is named `main` again.
- Neon's snapshot feature (one-step restore that keeps the connection string) is limited on Free to **1 manual snapshot, no schedules**. Registered as a possible complement, not adopted.
- Snapshots run daily (`db-backup.yml`); run by hand with `gh workflow run db-backup.yml`.
- Watch: monthly CU-hours (compute is suspended when exceeded) and the 0.5 GB storage ceiling.

## First production deploy (owner sequence, 2026-09-28)

Never deployed yet. Steps marked **owner** need credentials, accounts or dashboard access. Don't skip or reorder.

1. **Owner:** GitHub `production` environment with a required reviewer. Not available on the current plan: GitHub Free with a private repo has no environments, and required reviewers need a public repo or Enterprise. See ADR-0011.
2. **Owner:** production `BETTER_AUTH_SECRET`: `openssl rand -base64 32` piped straight into `wrangler secret put BETTER_AUTH_SECRET` (never pasted into chat, never committed).
3. **Owner:** production `BETTER_AUTH_URL` = `https://<custom domain>`, set with `wrangler secret put` (or as a var).
4. **Owner:** custom domain on a Cloudflare zone, attached to the Worker (Workers → Settings → Domains & Routes).
5. Observability: confirm Workers Logs are on for the Worker (`observability` in `wrangler.jsonc`) and that the inspection steps in the Observability section work.
6. **Restore point, then migrations.**
   - Take a restore point: `gh workflow run db-backup.yml`, then confirm `backup-YYYYMMDD` exists (`neonctl branches list --project-id flat-cherry-23373668`). On Neon Free, PITR only reaches back 6 h.
   - Migrate: `DATABASE_URL="$(neonctl connection-string main --project-id flat-cherry-23373668 --database-name app --role-name app_owner)" pnpm db:migrate`. Direct (non-pooler) URL, never printed or logged.
   - Pending now: `0000` (slice schema) and `0001` (`rate_limit`); both only create tables.
7. First deploy: `pnpm run deploy` (not `pnpm deploy`, which is a pnpm built-in) from a clean `main` checkout (production credentials never go through CI; ADR-0011).
8. Smoke test on the custom domain:
   - `/api/health` returns `ok`
   - sign-up, login, create an organization
   - invitation flow, if email is ready (ADR-0005, Q7)
   - login rate limit: 6 wrong-password POSTs to `/api/auth/sign-in/email` from one IP within 60 s; the 6th returns **429**
9. **Owner:** add the WAF rule `auth-login-burst` (ADR-0005, edge layer).
10. Smoke-test the WAF on its own: more than 10 POSTs to `/api/auth/sign-in/email` within 10 s from one IP are blocked at the edge (Cloudflare block page, visible in Security → Events). Wait 60 s so the app's own limit resets, and check that a normal login still works.

Rollback: `wrangler rollback` to the previous Worker version (code only). Migrations are forward-only (expand → migrate → contract). For data, use the Database section below.

Planned: routine deploys, migrations after launch.
