# ADR-0023: Off-provider database dumps to Cloudflare R2

Status: Accepted (owner decisions 2026-09-30). The first live dump and the restore test are pending (runbook "Database"). · Date: 2026-09-30

Implements [ADR-0003](0003-neon-postgres-via-hyperdrive-drizzle.md)'s backup option B, the trigger [ADR-0007](0007-defer-cloudflare-products.md) names for R2, and the backup half of [ADR-0014](0014-first-production-launch-gates.md)'s data gate.

## Context

- Production data lives only in Neon. Neon's 6 h restore window and the daily snapshot branches (option A, `snapshot.sh`) are the same provider: they don't survive a Neon outage, the loss of the Neon account, or deletion of the project.
- ADR-0014: production holds no real customer data until an off-provider dump exists **and** a restore from it has been tested.
- A Worker can't run `pg_dump`. The existing snapshot job already runs daily in GitHub Actions, in the `main`-only `production` environment, with the production-project Neon key.
- R2 API tokens (Cloudflare docs, "R2 API tokens", checked 2026-09-30): the narrowest permission is **Object Read & Write** on specified buckets. There is no write-only permission, so the upload token can also read, list and delete the dumps.
- Size: the database is capped at 0.5 GB (Neon Free), well inside R2's free 10 GB.

## Decision

1. **A daily `pg_dump` to R2 from GitHub Actions.** Job `dump` in `db-backup.yml`, next to `snapshot` (same schedule, independent), runs `scripts/backup/dump.sh`:
   - gets the direct (non-pooler) URL of production `main` with the existing `NEON_API_KEY` (no new database credential), masked and never printed; the key reaches the CLI and the URL reaches `pg_dump` through the environment and an env file, never through process arguments;
   - `pg_dump --format=custom` with the Postgres 17 client (image in the clarification below);
     - _Clarification (owner, 2026-09-30):_ the client runs from the client-only image `gmarrot/postgresql-client:17` (Alpine + `postgresql17-client`, about 20 MB instead of about 420 MB), pinned by digest in `dump.sh` because the container receives the production password; the script refuses a `pg_dump`/`pg_restore` that isn't PostgreSQL 17 and uses host networking only for a loopback database (local testing). A third-party image: bump the digest by hand after checking what it contains. The runbook's local restore still uses `postgres:17-alpine`, which needs the server.
   - fails unless `pg_restore --list` reads the dump and lists data for `organization`, `member`, `user` and `drizzle.__drizzle_migrations`;
   - uploads `daily/app-YYYYMMDD.dump` and `daily/app-YYYYMMDD.dump.sha256`, checking the stored size before writing the `.sha256`, which marks the day complete; a re-run skips a complete day and redoes a partial one.
   - A failed run surfaces as GitHub's failed-workflow email to the owner until alerting exists (ADR-0015).
2. **Bucket `saas-foundation-prod-db-dumps`** in the production account: private (no public access, no custom domain), location automatic. **Retention: a lifecycle rule deletes objects after 30 days.** No bucket lock, so a dump can still be removed early (for example after a data deletion request).
3. **Credentials** (environment `production`, `main` only; runbook "CI credentials"): secrets `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY` and `R2_BACKUP_ENDPOINT` from the account API token `r2-dump-backups` (Object Read & Write on this bucket only), variable `R2_BACKUP_BUCKET`. The token's bearer value isn't stored. Like `NEON_API_KEY`, they reach only the dump step.
4. **Encryption: R2's managed encryption at rest only** (owner decision; this is also the template default). **Accepted risk:** anyone holding the R2 credentials, or with dashboard access to the bucket, can read every dump in plain text. The credentials' only defense is the `production` environment's fence.
   - **Documented, not built:** client-side public-key encryption with `age`. CI would hold only the public key (`BACKUP_AGE_RECIPIENT`) and the owner the private key, offline; a leaked R2 credential would then expose nothing (the Neon key still reaches production data directly). Adopting it later is a change to `dump.sh` and the restore procedure, recorded in a new ADR.
5. **Restore** (runbook "Database"): download a dump and its `.sha256` from the dashboard, check it, `pg_restore --no-owner --no-acl` into a local `postgres:17` container, and compare exact row counts per table with production. Nothing touches Neon. The data gate's "restore tested" condition is met when this is done once against a dump written by the scheduled job and recorded in the runbook.
6. **No Worker binding.** R2 is reached only through its S3 API from CI; `apps/web/wrangler.jsonc` doesn't change and no preview can see the bucket. Previews stay isolated because the credentials exist only in `production`, which PR code never runs in.

## Alternatives

- **A Worker (cron trigger) writing to an R2 binding:** no `pg_dump` in workerd, and the Worker would need production bucket write access. Rejected.
- **Another Neon project or region:** same provider. Rejected: it doesn't cover the account.
- **GitHub Actions artifacts:** retention capped at 90 days, readable by anyone with repo read access. Rejected.
- **A bucket lock (retention rule) against a leaked token deleting dumps:** deferred; it would also block early deletion.

## Consequences

- Neon compute wakes for about a minute a day (CU-hours; runbook "Watch").
- The R2 token is now a production-data credential: rotate it like the Neon key (runbook "CI credentials").
- Lifting the data gate still needs its own ADR (ADR-0014), after the restore test is recorded.
