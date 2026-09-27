# ADR-0011: Each PR preview gets its own Neon branch and Hyperdrive config

Status: Accepted · Date: 2026-09-27

## Context

- Workers Previews share production storage bindings by default.
- `wrangler preview` has no binding-override flags; it uses the checked-out `wrangler.jsonc`.
- The Cloudflare Vite plugin bakes the config into the build output.
- Hyperdrive allows 25 configs per account on Workers Paid.

## Decision

Per PR: Neon branch `preview/pr-N` (parent: `preview-seed`, **schema + synthetic data only**) → migrate → Hyperdrive config `saas-pr-N` (`--caching-disabled`) → CI writes its id into `previews.hyperdrive` of the workspace `wrangler.jsonc` **before** the build → `wrangler preview --name pr-N`. On PR close, delete all three; a daily job removes orphans.

## Consequences

- Previews are isolated and exercise the production connection path.
- At most ~23 concurrent PR previews; cleanup must be reliable.
- Preview URLs are public unless protected (Cloudflare Access).
- Better Auth needs `BETTER_AUTH_URL` per preview host.
- **The CI is built only after a manual one-PR experiment** proves creation, deployment, authentication, DB connectivity and cleanup.
