# Database: Neon Postgres through Hyperdrive

## Responsibility

All application data lives in Postgres: Neon in production and previews, a local Docker container in development and tests. The Worker reaches it through the Hyperdrive binding `DB`, which pools connections and has **caching disabled**, so every read is fresh, including the membership read on every tenant request ([ADR-0003](../adr/0003-neon-postgres-via-hyperdrive-drizzle.md), [ADR-0004](../adr/0004-uncached-hyperdrive-binding.md), invariant 7). Which rows a request may touch is our code's decision, not the database's: see "Tenant boundary" below.

## Owning files

| File                                                                                     | Role                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/app/src/server/db.ts`](../../apps/app/src/server/db.ts) (`withDb`)                | one client per request from `env.DB.connectionString`, always closed; maps a deleted-account refusal to 401 (ADR-0044)                          |
| [`apps/app/src/server/health.ts`](../../apps/app/src/server/health.ts)                   | `GET /api/health`: one round trip, 503 and `health.db_down` when it fails                                                                       |
| [`packages/db/src/client.ts`](../../packages/db/src/client.ts) (`createDb`)              | the opaque `Db` handle, connect/statement/close bounds                                                                                          |
| [`packages/db/src/connection.ts`](../../packages/db/src/connection.ts) (`GuardedClient`) | the only pg client: refuses statements on a connection a tenant transaction owns, and statements that set the tenant context outside the helper |
| [`packages/db/src/tenant-transaction.ts`](../../packages/db/src/tenant-transaction.ts)   | `inTenant` / `enterTenant`: transaction-local `app.org_id` (ADR-0040 decision 1)                                                                |
| [`packages/db/src/`](../../packages/db/src/) repositories, `schema/`, `drizzle/`         | every query, every table, every migration (invariants 2, 3, 10)                                                                                 |

`createDb` is called only from `server/db.ts` and `server/health.ts`, and routes and components don't import `server/db`; lint enforces both (AGENTS.md "Module map").

## Configuration

| Name                                | Where                                                                                | Notes                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB` (Hyperdrive binding)           | [`apps/app/wrangler.jsonc`](../../apps/app/wrangler.jsonc), and its `previews` block | the only database binding; `localConnectionString` points at the local `app` database as `app_runtime`. A cached binding needs an ADR (invariant 7). |
| Test database URL                   | [`apps/app/vitest.config.ts`](../../apps/app/vitest.config.ts)                       | `app_test` as `app_runtime`; `scripts/test-lock.sh` derives its lock name from it                                                                    |
| `DATABASE_URL`                      | `pnpm db:migrate`, `db:generate`                                                     | defaults to the local `app` database as its owner; migrations always run as the owner                                                                |
| Connect, statement and close bounds | constants in `packages/db/src/client.ts`                                             | how long a request waits on an unresponsive or lost database before failing                                                                          |

Roles: the app connects as `app_runtime`, with explicit per-table grants and no default privileges; migrations, backups and previews use the owner `app_owner` (invariant 7, [ADR-0038](../adr/0038-least-privilege-database-runtime-role.md)). A new table gets its grant migration and its `GRANTS` entry in `apps/app/test/database-role.test.ts`; the owner-only `archive` schema gets no runtime privilege ([ADR-0039](../adr/0039-archive-and-audit-triggers.md)).

## Environments

| Environment | Database                                                                                                                                                                                               | Connection                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local       | Docker `postgres:17-alpine` on `127.0.0.1:5432`, shared by every checkout on the machine ([`docker-compose.yml`](../../docker-compose.yml)): `app` for `pnpm dev` and E2E, `app_test` for Worker tests | `localConnectionString`; no Hyperdrive involved                                                                                                  |
| CI          | a Postgres 17 service in the Validate job                                                                                                                                                              | the same local URLs                                                                                                                              |
| Preview     | its own Neon branch `preview/pr-N` in the separate preview project, reset from `preview-seed` on every deploy                                                                                          | its own Hyperdrive config `saas-pr-N`, deleted on close ([ADR-0021](../adr/0021-per-pr-preview-data-behind-a-trusted-boundary.md), invariant 15) |
| Production  | Neon, `aws-us-east-1`, the Worker placed next to it                                                                                                                                                    | production Hyperdrive config, caching off                                                                                                        |

Local runs never exercise Hyperdrive. Behaviour that depends on it (transaction-local context through the pool, no cache crossing tenants, latency) was validated on a preview (ADR-0040 Notes; roadmap M1 and M2), not by `pnpm test`.

## Data exchanged

Everything the app stores: identity and session rows (Better Auth's tables), organizations, memberships, invitations, projects, billing subscription copies and gates, and the owner-only archive of deleted rows. Connection credentials stay in Hyperdrive's configuration, never in code or logs.

## Tenant boundary

The boundary today is the repository: every function takes `ctx.orgId` from a verified tenant context, and every statement on `project` and `billing_subscription` runs in `inTenant`, with the tenant set transaction-locally ([ADR-0040](../adr/0040-tenant-row-level-security.md) decisions 1–4). `GuardedClient` is defense in depth. Row-level security policies (decisions 5–6) are **proposed, not enforced** (roadmap M4). Better Auth's tables stay filter-only by design.

## Failures

| What happens                                           | What the app does                                                                                                                                               | Evidence                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database unreachable or lost mid-request               | connect and each statement fail within their bounds and the request fails with an error instead of hanging; `/api/health` answers 503 and logs `health.db_down` | [`connection-loss.test.ts`](../../apps/app/test/connection-loss.test.ts), [`health.test.ts`](../../apps/app/test/health.test.ts)                      |
| A statement times out inside a tenant transaction      | the transaction can't commit afterwards, even if the caller catches the timeout                                                                                 | `connection.ts`, [`tenant-transaction.test.ts`](../../apps/app/test/tenant-transaction.test.ts)                                                       |
| A statement the runtime role isn't granted             | Postgres refuses with SQLSTATE `42501`; the request fails                                                                                                       | [`database-role.test.ts`](../../apps/app/test/database-role.test.ts); [troubleshooting](../troubleshooting/README.md#database-privilege-errors-42501) |
| A write for a deleted account                          | the `refuse_deleted_user` trigger refuses; `withDb` answers 401                                                                                                 | [`account-deletion.test.ts`](../../apps/app/test/account-deletion.test.ts)                                                                            |
| A write that would leave an organization with no owner | the `member_keeps_owner` trigger fails the commit; server functions answer 409                                                                                  | [`organization-settings.test.ts`](../../apps/app/test/organization-settings.test.ts), ADR-0043                                                        |

## Retry safety

A statement that timed out may still have run on the server: pg's timeout doesn't cancel it (comment in `connection.ts`). Inside one repository call (one transaction), a failure commits nothing. A server function that calls several repositories gets several short transactions, so a failure part-way can leave the earlier ones committed (ADR-0040 decision 3). An operation that must be atomic is one `packages/db` function with one `inTenant`.

## Tests and operations

- Tests: [`docs/testing.md`](../testing.md) "Tenant isolation" and "Database checks"; `pnpm db:check` for migrations.
- Runbooks: ["Database"](../runbooks/README.md#database-adr-0003-neon-free) (restore, backups by hand), ["Runtime role"](../runbooks/README.md#runtime-role-adr-0038), ["Archive and audit"](../runbooks/README.md#archive-and-audit-adr-0039), ["Recovery card"](../runbooks/README.md#recovery-card-adr-0036).
- Concepts: [domain model](../architecture/domain-model.md).
