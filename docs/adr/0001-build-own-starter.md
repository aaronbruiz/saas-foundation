# ADR-0001: Build our own starter instead of adopting or forking a template

Status: Accepted · Date: 2026-09-27

## Context

Six public Cloudflare SaaS templates were reviewed (GitHub metadata and `package.json` inspected 2026-09-27). None matched the target: most are D1-first, several depend on stale or experimental Next.js adapters (`next-on-pages`, vinext beta), and some split into multiple Workers or use non-standard IaC (Alchemy).

## Decision

Build an opinionated starter from proven libraries. Templates are a source of patterns only; nothing is adopted or forked.

## Consequences

- We own every integration (auth wiring, CI, billing); a slower start.
- Invariants, tenancy and agent docs exist from commit zero.
- Patterns worth mining: backpine/saas-kit (`data-ops` split, Better Auth + Postgres), LubomirGeorgiev (RFC 9457 errors, Stripe flows), mw10013 (Better Auth org + Stripe).
