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

- Neon project `saas-foundation` (`flat-cherry-23373668`), `aws-us-east-1`, Postgres 17, database `app`, role `app_owner`. Branches: `main` (production), `preview-seed` (no compute; parent for PR branches).
- Hyperdrive `saas-foundation-prod` (`29b70e89b57945e1875c0a030b377243`), caching disabled, Neon direct host.
- **Plan gap, blocks production:** the Neon organization is currently on the **Free** plan. The restore window is capped at **6 hours** (7 days needs Launch), and scale-to-zero **can't be disabled**. Upgrade to Launch, then set `history_retention_seconds = 604800` and the production endpoint's `suspend_timeout_seconds = -1`, before any production traffic.
