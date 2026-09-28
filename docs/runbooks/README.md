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

- Restore: Neon point-in-time restore covers only the **last 6 hours**. Beyond that, see the open backup decision in ADR-0003.
- Watch: monthly CU-hours (compute is suspended when exceeded) and the 0.5 GB storage ceiling.

Planned: deploy & rollback, migrations.
