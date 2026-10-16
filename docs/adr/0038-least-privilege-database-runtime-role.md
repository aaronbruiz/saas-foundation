# ADR-0038: Least-privilege database runtime role

Status: Proposed · Date: 2026-10-16

## Context

The Worker, migrations and backups all connect as one Neon role, `app_owner` (ADR-0003; `scripts/common.sh`). On Neon, a role created in the Console, CLI or API gets these, verified on a disposable preview-project branch on 2026-10-15:

- `rolbypassrls = true` on the role itself, plus `CREATEROLE`, `CREATEDB` and `REPLICATION`;
- membership in `neon_superuser`, so it inherits `pg_read_all_data` and `pg_write_all_data`;
- ownership of every table, since migrations run as it.

So a bug or a stolen credential in the Worker can alter or drop the schema, create roles, read every table and skip any row-level security policy. A role created with SQL (`CREATE ROLE`) gets none of these: every attribute false, no memberships, owns nothing (same branch check).

Tenant isolation stays in application code: `getTenantContext` and the `packages/db` repositories (AGENTS.md invariants 1–3). R06 (local research, 2026-10-15) also prototyped row-level security and an audit trigger. Both depend on the Worker not being the owner and not bypassing RLS, so this ADR is their prerequisite. They wait for R04's latency baseline and R05's schema direction.

## Decision

1. **The app connects as `app_runtime`**, a role created by migration `0005_runtime_role` as `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT` (only when it doesn't exist; roles are cluster-wide). It owns nothing and is a member of no role.
2. **Explicit per-table grants, no default privileges.** The migration grants `USAGE` on `public` and only these table privileges:

   | Tables                                                                                     | Privileges                     | Why                                                                                                 |
   | ------------------------------------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------- |
   | `session`, `account`, `verification`, `organization`, `member`, `invitation`, `rate_limit` | SELECT, INSERT, UPDATE, DELETE | Better Auth's adapter manages them (sign-out, password and invitation flows, organization deletion) |
   | `user`                                                                                     | SELECT, INSERT, UPDATE         | account deletion is off; test-user cleanup runs as the owner (runbook)                              |
   | `project`                                                                                  | SELECT, INSERT, UPDATE, DELETE | the projects repository                                                                             |
   | `billing_subscription`                                                                     | SELECT, INSERT, UPDATE         | webhook upsert; rows go only through the organization's cascade                                     |
   | `billing_webhook_event`                                                                    | SELECT, INSERT                 | an append-only dedupe log                                                                           |

   No `TRUNCATE`, `REFERENCES` or `TRIGGER`. No access to the `drizzle` schema. A new table gets no privileges, so the app fails closed until a migration grants them. `apps/app/test/database-role.test.ts` checks the role's attributes, memberships and ownership, the exact grants on every table, and that DDL, `TRUNCATE`, role creation and deletes from the append-only tables are refused. A table missing from its list fails the test.

3. **The owner keeps migrations, backups and previews.** `app_owner` runs `scripts/release/migrate.sh`, `scripts/backup/*` and the preview migrator, as today. Previews keep their per-branch `app_owner` credential (ADR-0021) until a follow-up moves them to the runtime role (step 6).
4. **No committed password.** The migration creates the role without a login. Each environment gives it one separately:
   - local docker-compose and CI: `docker/postgres-init/02-runtime-role.sql` and `apps/app/test/local-runtime-role.ts` set the known local password `app_runtime`, only against `localhost`;
   - production: the owner generates a random password in their own terminal and sets it with a plaintext `ALTER ROLE app_runtime LOGIN PASSWORD :'pw'` over verified TLS. `psql` fills in `:'pw'` from an environment variable (`\getenv`), so the password never appears in argv, files, shell or psql history. It's stored only in the Hyperdrive config, which receives it in an API request body on stdin (runbook "Database → Runtime role"). Neon refuses pre-hashed SCRAM verifiers ("Neon only supports being given plaintext passwords", 2026-10-16), so `psql`'s `\password` doesn't work there. Postgres receives the password in plaintext, so before setting it the runbook checks that statement logging is off (`log_statement = none`) and that `pg_stat_statements` isn't installed. The alternative is Neon's reset-password API (runbook), not yet verified for a role created in SQL.
5. **Production switches only after verification and explicit owner approval.** The runbook's gates must all be recorded there first:
   - (a) the role, its grants and a Hyperdrive login checked on a disposable preview-project branch (done 2026-10-16, see Notes);
   - (b) migration 0005 released to production;
   - (c) the app itself working through Hyperdrive as `app_runtime`: a PR preview's e2e run, or an approved isolated Worker smoke test;
   - (d) the owner's explicit approval to change production credentials.

   Only then: set the production password, update `saas-foundation-prod`, confirm the identity and `/api/health`, and watch Workers Issues for `42501` (permission denied). Until then production keeps `app_owner`. The migration is harmless there: the role exists without a login.

6. **Follow-ups, not decided here:** move previews to the runtime role (infra.sh would set a per-branch password; it needs Actions to verify); row-level security on tenant tables and a delete-audit trigger (R06 phases 2–3, after R04 and R05, in their own ADR).

## Residual risks (stated, not solved by this ADR)

- **Tenant isolation is still application code.** The runtime role can read and write every tenant's rows in the tables it's granted. A repository function that misses its `orgId` filter still leaks. RLS (follow-up) is the layer for that.
- **Auth tables are fully exposed to the runtime role.** Better Auth reads and writes `user`, `session`, `account`, `member`, `invitation` and `organization` across tenants (session lookup comes before the tenant is known). So the runtime credential gives access to every account's password hash, session tokens and memberships. Narrowing this needs Better Auth changes, not grants.
- **Organization deletion cascades.** The runtime role needs `DELETE` on `organization` (Better Auth's delete endpoint). Foreign-key cascades then remove that organization's projects, billing record, members and invitations without checking the runtime role's own privileges (they run as the table owner). The checks before a deletion (ADR-0020 live subscription, ADR-0022 owner hooks) are application code. A stolen runtime credential could delete any organization. Recovery is the backups (ADR-0036).
- **Unique and foreign-key checks** can reveal whether ids exist in another tenant to anyone running arbitrary SQL as the runtime role (no such path today: ids are generated by the server).
- **`TEMP` and `CONNECT`** stay granted to `PUBLIC` on the database (Postgres default). Revoking them on Neon's managed database wasn't tested.
- **The owner remains all-powerful** (migrations, backups, Neon's `BYPASSRLS`). Migration review and the destructive-migration gate (ADR-0029 decision 7) stay the control.

## Consequences

- **Adding a table** (AGENTS.md recipe) now also means granting its privileges to `app_runtime` in a migration (`drizzle-kit generate --custom`) and adding it to `GRANTS` in `test/database-role.test.ts`.
- **Restores:** dumps are restored with `--no-acl` (runbook), so the grants don't come back with the data. After a restore, re-apply `packages/db/drizzle/0005_runtime_role.sql` and later grant migrations with `psql -v ON_ERROR_STOP=1 -f` (idempotent), then give the role its login on the new project.
- **Local setup:** a fresh docker volume creates the role with its local login. An existing volume gets it the first time `pnpm test` or `pnpm test:e2e` runs; `pnpm dev` alone needs `pnpm db:migrate` and one test run first.
- **Rollback:** point `saas-foundation-prod` back at `app_owner` (`wrangler hyperdrive update … --connection-string=<app_owner URL>`). The role and grants can stay; removing them later is a contract migration.

## Alternatives

- **Keep `app_owner` for the Worker:** keeps DDL, role management, `BYPASSRLS` and all-data roles in the Worker, and rules out RLS.
- **Create the runtime role in the Neon Console or API:** it would get `neon_superuser` membership and `BYPASSRLS` like `app_owner`.
- **Default privileges** (`ALTER DEFAULT PRIVILEGES … GRANT … TO app_runtime`): every new table would be readable and writable by the app before anyone decided, failing open (R06 Codex review).
- **Column-level grants on the auth tables:** Better Auth's adapter selects whole rows; it would break sign-in for little gain.

## Notes

- **2026-10-16, gate (a) verified** on a disposable preview-project branch `runtime-check`, with a temporary Hyperdrive config `saas-runtime-check`. Both were deleted afterwards, and the production Hyperdrive config's fingerprint was unchanged.
  - Migration as `app_owner`: `app_runtime` was created without a login and with every attribute false. Its grants matched decision 2 exactly. `app_owner` became an admin member of it, without inherit or `SET`.
  - After `LOGIN` and a password, as `app_runtime` over certificate-verified TLS:
    - no memberships, nothing inherited (`neon_superuser`, `pg_*_all_data`, `app_owner`) and nothing owned;
    - DDL, `TRUNCATE`, deletes on the add-only tables, the migrations table, `CREATE ROLE` and `SET ROLE app_owner` refused (`42501`), and `SET ROLE neon_superuser` refused by Neon.
  - Creating the Hyperdrive config as `app_runtime` succeeded (caching disabled; the API doesn't return the password). The same origin with a wrong password was refused (code 2013).
  - Found: Neon refuses SCRAM verifiers, so decision 4 now uses a plaintext password over TLS.
  - Evidence is in the owner's local research artifacts (`R06-artifacts/runtime-check-2026-10-16.txt`, sanitized).
