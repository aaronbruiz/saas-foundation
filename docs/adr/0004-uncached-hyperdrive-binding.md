# ADR-0004: Read auth and permission data through an uncached Hyperdrive binding

Status: Accepted · Date: 2026-09-27

## Context

Hyperdrive caches read queries by default (`max_age` 60 s). A stale read can authorize a revoked member. Caching is configured **per Hyperdrive configuration, not per query**.

## Decision

v1 binds a single Hyperdrive config, `DB`, created with `--caching-disabled`. A cached config (`DB_CACHED`) is added only via a new ADR, for a named hot read that tolerates staleness.

## Consequences

- Auth, membership, billing-state and read-after-write reads can't go through a cache by mistake.
- No query-cache benefit until it's deliberately introduced. Connection pooling still applies.
