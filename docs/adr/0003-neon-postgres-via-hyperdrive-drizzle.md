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
