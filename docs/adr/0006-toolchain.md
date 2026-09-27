# ADR-0006: Toolchain: pnpm, TypeScript 6, ESLint 9 + Prettier, Zod, Vitest 4, Playwright

Status: Accepted · Date: 2026-09-27

## Decision

- **pnpm workspaces** (`apps/*`, `packages/*`), pnpm version pinned via `packageManager`, Node 24. No Bun. Turborepo deferred until CI build time hurts.
- **TypeScript `~6.0`**: typescript-eslint supports `<6.1`, so TS 7 is excluded for now. `tsc --noEmit` is a separate gate.
- **ESLint v9 flat config + Prettier** (boring and mature; the plugin ecosystem carries the architecture boundary rules). Revisit Biome/Oxlint only if CI measurements show lint is expensive.
- **Zod** at every server boundary (`packages/contracts`).
- **Vitest `^4.1` + `@cloudflare/vitest-pool-workers`**: the pool doesn't support Vitest 5 yet. **Playwright** for E2E.
- **`wrangler.jsonc`** in the repo is the v1 infrastructure-as-code; Wrangler `^4.142` (≥ 4.135 needed for Previews).
- `pnpm check` = lint + format:check + typecheck. Tests run separately.

## Consequences

- One command vocabulary for people, agents and CI.
- Dashboard-level resources (DNS, WAF, Hyperdrive configs) stay outside the repo until Terraform is justified.
