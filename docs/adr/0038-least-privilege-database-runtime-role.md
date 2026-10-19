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

   | Tables                                                                          | Privileges                     | Why                                                                                                 |
   | ------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
   | `session`, `verification`, `organization`, `member`, `invitation`, `rate_limit` | SELECT, INSERT, UPDATE, DELETE | Better Auth's adapter manages them (sign-out, password and invitation flows, organization deletion) |
   | `account`                                                                       | SELECT, INSERT, UPDATE         | no enabled flow deletes one (`DELETE` revoked by `0007_hashed_verification`, Notes 2026-10-19)      |
   | `user`                                                                          | SELECT, INSERT, UPDATE         | account deletion is off; test-user cleanup runs as the owner (runbook)                              |
   | `project`                                                                       | SELECT, INSERT, UPDATE, DELETE | the projects repository                                                                             |
   | `billing_subscription`                                                          | SELECT, INSERT, UPDATE         | webhook upsert; rows go only through the organization's cascade                                     |
   | `billing_webhook_event`                                                         | SELECT, INSERT                 | an append-only dedupe log                                                                           |

   No `TRUNCATE`, `REFERENCES` or `TRIGGER`. No access to the `drizzle` schema. A new table gets no privileges, so the app fails closed until a migration grants them. `apps/app/test/database-role.test.ts` checks the role's attributes, memberships and ownership, the exact grants on every table, and that DDL, `TRUNCATE`, role creation and deletes from the append-only tables are refused. A table missing from its list fails the test.

3. **The owner keeps migrations, backups and previews.** `app_owner` runs `scripts/release/migrate.sh`, `scripts/backup/*` and the preview migrator, as today. Previews keep their per-branch `app_owner` credential (ADR-0021) until a follow-up moves them to the runtime role (step 6).
4. **No committed password.** The migration creates the role without a login. Each environment gives it one separately:
   - local docker-compose and CI: `docker/postgres-init/02-runtime-role.sql` and `apps/app/test/local-runtime-role.ts` set the known local password `app_runtime`, only against `localhost`;
   - production: the owner generates a random password in their own terminal and sets it with a plaintext `ALTER ROLE app_runtime LOGIN PASSWORD :'pw'` over verified TLS. `psql` fills in `:'pw'` from an environment variable (`\getenv`), so the password never appears in argv, files, shell or psql history. It's stored only in the Hyperdrive config, which receives it in an API request body on stdin (runbook "Database → Runtime role"). Neon refuses pre-hashed SCRAM verifiers ("Neon only supports being given plaintext passwords", 2026-10-16), so `psql`'s `\password` doesn't work there. Postgres receives the password in plaintext. So before setting it, the runbook checks that statement and duration logging are off and that `pg_stat_statements` isn't installed. `log_min_error_statement` (which the owner can't change) logs the statement if it fails, so a password from a failed attempt counts as exposed and is replaced. Neon's own logs are outside our control. Secrets reach containers on stdin, never through `docker run -e`, whose values Docker keeps in the container's configuration. The alternative is Neon's reset-password API (runbook), which sends no password through SQL but isn't yet verified for a role created in SQL.
5. **Production switches only after verification and explicit owner approval.** The runbook's gates must all be recorded there first:
   - (a) the role, its grants and a Hyperdrive login checked on a disposable preview-project branch (done 2026-10-16, see Notes);
   - (b) migration 0005 released to production;
   - (c) the app itself working through Hyperdrive as `app_runtime`: a PR preview's e2e run, or an approved isolated Worker smoke test;
   - (d) the owner's explicit approval to change production credentials.

   Only then: set the production password, update `saas-foundation-prod`, confirm the identity and `/api/health`, and watch Workers Issues for `42501` (permission denied). Until then production keeps `app_owner`. The migration is harmless there: the role exists without a login.

6. **Follow-ups, not decided here:** move previews to the runtime role (infra.sh would set a per-branch password; it needs Actions to verify); row-level security on tenant tables and a delete-audit trigger (R06 phases 2–3, after R04 and R05, in their own ADR).

## Residual risks (stated, not solved by this ADR)

Stating these risks doesn't accept them: the owner decides which to accept and which controls to add (see "Residual-risk review, 2026-10-18" in Notes). For now the app keeps Better Auth's self-service organization deletion and one shared runtime credential.

**Deployment state.** Until decision 5's gates pass, production runs as `app_owner` (migration 0005 isn't released; the release needs GitHub Actions, blocked since 2026-10-15). Everything an `app_runtime` holder could do below, the production credential can do today, plus DDL, `TRUNCATE` and bypassing RLS. Local development and tests already run as `app_runtime`.

Two kinds of actor are distinguished:

- **A user of the application's endpoints.** The examined paths enforce authorization in code: only an owner can delete their organization through Better Auth's `/organization/delete` (admins and members get 403, non-members 400; tests in `roles.test.ts`, `polar.test.ts`, `billing.test.ts`), and a live subscription or a failed Polar account removal refuses it. Deleting an organization's own projects, billing record, members and invitations is the intended effect of that deletion, not a vulnerability.
- **Anyone who can run arbitrary SQL with the runtime credential**: a leaked credential, code execution in the Worker, or a future injection or query defect. Application authorization doesn't apply to them, and the database can't tell them apart from the app: the role reads and writes all the sessions, memberships and roles that a database-side check would consult. RLS with an app-set tenant value (R06) doesn't stop them either, since they can set that value.

What that second actor can do with decision 2's grants (verified on a fresh local schema, 2026-10-18):

- **Tenant isolation is still application code.** The runtime role reads and writes every tenant's rows in the tables it's granted. A repository function that misses its `orgId` filter still leaks. RLS (follow-up) is the layer for that, for tables with policies only.
- **Auth tables: writes enable account and tenant takeover, not only reading.** Better Auth reads and writes `user`, `session`, `account`, `member`, `invitation` and `organization` across tenants (the session is looked up before the tenant is known). With the runtime credential one can read every password hash and session token. The writes split in two (all verified as database writes): **tenant takeover** by changing a member's role or inserting an owner membership in any organization, which the attacker then uses through their own account; and **account takeover** by writing an account's password hash, a user's email or a password-reset token, or by reassigning an existing session row to another user. That these account writes lead to signing in as the victim through the normal endpoints is inferred from Better Auth's source and was **not exercised end to end**. A session token read alone is not enough: the cookie is signed with `BETTER_AUTH_SECRET`. Narrower grants can't fix this, because Better Auth's supported flows need these writes; a separate auth credential would contain a leak of the app's credential (as long as the auth credential doesn't leak too), not a compromised Worker that holds both.
- **Organization deletion cascades past grants.** The runtime role has `DELETE` on `organization` (Better Auth's delete endpoint) but none on `billing_subscription`. A raw `DELETE FROM organization` still removes that organization's billing record (even an active one), projects, members and invitations, because foreign-key actions run as the table owner; it skips the live-subscription refusal (ADR-0020) and the Polar account removal (ADR-0022), which are application code. One statement can delete every organization. The role can't disable triggers or truncate. Recovery is Neon's restore window and the backups (ADR-0036). Better Auth's own delete wasn't atomic with the original adapter configuration: members and invitations were committed before the organization row, so a failure in between left an organization without members. `fix(auth): make organization deletion database-atomic` makes it one database transaction in the code (`drizzleAdapter(…, { transaction: true })`; verified locally against Postgres, not yet through Hyperdrive or in production, which runs the latest release until the next one). Clearing the caller's active organization and Polar's account removal run before that transaction and aren't undone by a rollback.
- **Unique and foreign-key checks** can reveal whether ids exist in another tenant to anyone running arbitrary SQL as the runtime role (no such path today: ids are generated by the server).
- **`TEMP` and `CONNECT`** stay granted to `PUBLIC` on the database (Postgres default). Revoking them on Neon's managed database wasn't tested.
- **The owner remains all-powerful** (migrations, backups, Neon's `BYPASSRLS`). Migration review and the destructive-migration gate (ADR-0029 decision 7) stay the control.

## Consequences

- **Adding a table** (AGENTS.md recipe) now also means granting its privileges to `app_runtime` in a migration (`drizzle-kit generate --custom`) and adding it to `GRANTS` in `test/database-role.test.ts`.
- **Restores:** dumps are restored with `--no-acl` (runbook), so the grants don't come back with the data. After a restore, re-apply `packages/db/drizzle/0005_runtime_role.sql` and later grant migrations (`0007_hashed_verification.sql` revokes `DELETE` on `account` again) with `psql -v ON_ERROR_STOP=1 -f` (idempotent), then give the role its login on the new project.
- **Local setup:** a fresh docker volume creates the role with its local login. An existing volume gets it the first time `pnpm test` or `pnpm test:e2e` runs; `pnpm dev` alone needs `pnpm db:migrate` and one test run first.
- **Rollback:** point `saas-foundation-prod` back at `app_owner` through the Hyperdrive API (runbook `hd_point app_owner`, which also restarts the pool; no credential in argv). Optionally remove `app_runtime`'s login. The role and grants can stay; removing them later is a contract migration.

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
- **2026-10-18, residual-risk review** (local research; recommendations only, none adopted by this ADR):
  - Reproduced on a disposable local Postgres 17 with migrations 0000–0005 applied by a non-superuser owner and synthetic data, as `app_runtime`: the grants above exactly; `DELETE` on `billing_subscription` and `user`, `TRUNCATE`, `DISABLE TRIGGER`, `session_replication_role`, DDL, `CREATE ROLE` and `SET ROLE app_owner` refused; the organization cascade and the auth-table writes listed under Residual risks allowed. Fresh schema only; the upgrade path on Neon is gate (a)'s check.
  - The candidate controls, in order: make Better Auth's organization delete atomic (`fix(auth): make organization deletion database-atomic`; production gets it with the next release); correct this section (done here); owner-owned archive/audit triggers that copy deleted tenant rows and record access-granting auth writes; optionally hashed password-reset identifiers. A deletion cap was prototyped and not recommended without an owner decision: as a global counter it lets anyone block legitimate deletions, and the prototype didn't serialize concurrent deletes.
  - **The archive prototype's evidence is partial.** Its recorded committed run shows the organization, its projects and its billing record captured, attributed to `app_runtime`, and the runtime role unable to read, change or disable the archive. Capture of members and invitations follows from the same row trigger on those tables but isn't shown by that run (its organizations had none).
  - **What such an archive would and wouldn't give:** it's protected against `app_runtime`, not against the owner; it attributes a database login, not a verified person; it's written in the deleting transaction, so rolled-back attempts leave nothing; and it doesn't replace an independently recoverable backup.
- **2026-10-18, ADR-0039** adds the owner-owned archive/audit triggers (migration `0006_archive_audit`): copies of deleted tenant, `user` and `account` rows and a record of access-granting auth writes, unreachable by `app_runtime`. They record and don't prevent; the limits above still apply.
- **2026-10-19, `DELETE` on `account` revoked** (migration `0007_hashed_verification`, owner decision: least privilege over keeping an unused grant). In Better Auth 1.7.7 only these delete `account` rows: `/unlink-account` (which refuses a user's last account, and with email and password every user has exactly one: a clean 400, tested), self-service user deletion (`user.deleteUser`, off), and the magic-link and email-OTP plugins (promoting an unproven account; not installed). A user delete's cascade runs as the table owner and still removes accounts. **Enabling user deletion, account linking with unlinking, magic links or email OTP needs `GRANT DELETE ON account TO app_runtime` again**, in a migration with this table and `GRANTS` updated; without it those flows fail with `42501` (a 500). Verified with `has_table_privilege` (which counts PUBLIC and role memberships; the role has none) in `database-role.test.ts`, and a raw `DELETE FROM account` as the runtime role is refused.
