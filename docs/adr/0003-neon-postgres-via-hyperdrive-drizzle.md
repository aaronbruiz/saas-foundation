# ADR-0003: Neon PostgreSQL via Hyperdrive, with Drizzle

Status: Accepted · Date: 2026-09-27

## Context

We need a relational, transactional store for a multi-tenant model. D1 (SQLite) was rejected as the primary store; "D1 in dev, Postgres in prod" was rejected because Drizzle schemas are dialect-specific.

## Decision

- Neon Postgres (`aws-us-east-1`, Launch plan) is the only system of record. The Worker connects through Hyperdrive using `pg` + `drizzle-orm/node-postgres`, **creating the client per request**.
- Local development uses Postgres in Docker via the binding's `localConnectionString`.
- Migrations: `drizzle-kit` in `packages/db`. No D1.
- Neon settings: set the restore window to **7 days** explicitly (the plan default is 1 day), and **disable scale-to-zero on production compute** (it's on by default after 5 minutes idle).

## Consequences

- Standard SQL, full transactions, portable off Cloudflare.
- Every query pays the Worker → DB round trip: keep queries few and batched per request.
- Restore procedure: Neon PITR (≤ 7 days) → new branch → verify → repoint the production Hyperdrive config (runbook to be written before launch).

## Status of cloud resources (2026-09-27)

- **Production:** Neon project `saas-foundation` (`flat-cherry-23373668`), `aws-us-east-1`, Postgres 17, database `app`, role `app_owner`, branch `main`. Hyperdrive `saas-foundation-prod` (`29b70e89b57945e1875c0a030b377243`), caching disabled, Neon direct host.
- **Previews:** a separate Neon project `saas-foundation-preview` (`withered-credit-11647832`) whose default branch is `preview-seed` (see ADR-0011).

## Amendment: Neon stays on the Free plan (owner decision 2026-09-27)

The Neon plan will not be upgraded. That replaces the Launch-plan assumptions above with these **accepted constraints** (per project):

| Constraint                                                                                    | Consequence                                                                                                                |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Restore window **6 hours** (not 7 days)                                                       | Neon alone can only undo mistakes noticed within 6 h. A separate backup strategy is an **open decision** (not chosen here) |
| Scale-to-zero after 5 min, **can't be disabled**                                              | The first request after idleness pays a compute cold start                                                                 |
| **100 CU-hours/month**; when exceeded, compute is **suspended until the next billing period** | Previews must not share production's project (hence ADR-0011's separate preview project). Watch production usage           |
| **0.5 GB storage**; writes fail beyond it                                                     | Monitor database size; it's a hard ceiling on data volume                                                                  |
| 10 branches per project; up to 2 CU                                                           | Production is small by design                                                                                              |
