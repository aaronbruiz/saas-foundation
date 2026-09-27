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

## Implementation (2026-09-27)

- **Separate Neon project for previews** (`saas-foundation-preview`, `withered-credit-11647832`, parent branch `preview-seed`). On Neon Free (ADR-0003), compute, storage and branch limits are per project, and exhausting compute **suspends every branch**. Previews therefore live outside production's project: at most **9 concurrent PR previews** (10 branches minus `preview-seed`).
- **Manual experiment on PR #3 passed:**
  - branch → migrate → Hyperdrive → inject → build → `wrangler preview` → `/api/health` OK → cleanup, no orphans.
  - The Vite plugin carries the injected `previews` block into `dist/server/wrangler.json`.
  - The deployed preview's `DB` resolved to the PR's config; production compute stayed idle.
  - No production deployment was needed.
- **Automation:** `scripts/preview/{up,down,janitor}.sh`, run by `.github/workflows/ci.yml` (job `preview`, after check + test) and `preview-cleanup.yml` (on PR close + daily janitor).
- **Not yet verified:** authentication on previews (Better Auth arrives with Vertical Slice 001; use `wrangler preview --var`/`--secrets-file` for `BETTER_AUTH_URL` and secrets). Preview URLs are public on `workers.dev`.
