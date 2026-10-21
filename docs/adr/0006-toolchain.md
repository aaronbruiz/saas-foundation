# ADR-0006: Toolchain: pnpm, TypeScript 6, ESLint 9 + Prettier, Zod, Vitest 4, Playwright

Status: Accepted · Date: 2026-09-27

## Decision

- **pnpm workspaces** (`apps/*`, `packages/*`), pnpm version pinned via `packageManager`, Node 24. No Bun. Turborepo deferred until CI build time hurts.
- **TypeScript `~6.0`**: typescript-eslint supports `<6.1`, so TS 7 is excluded for now. `tsc --noEmit` is a separate gate.
- **ESLint v9 flat config + Prettier** (boring and mature; the plugin ecosystem carries the architecture boundary rules). Revisit Biome/Oxlint only if CI measurements show lint is expensive.
- **Zod** at every server boundary (`packages/contracts`).
- **Vitest `^4.1` + `@cloudflare/vitest-plugin`** (the `cloudflareTest()` plugin Cloudflare's docs now recommend; peer `vitest ^4.1`, so no Vitest 5 yet). Tests run inside workerd with the real `DB` binding, pointed at the `app_test` database. **Playwright** for E2E.
- Known test-runner workaround: `apps/web/vitest.config.ts` aliases `pg-protocol` and `pg-cloudflare` to their CommonJS builds, because the runner resolves `pg`'s `require()` calls to ESM or non-workerd stubs. Dev and build don't need it. Remove the aliases when the plugin or `pg` fixes this.
- **`wrangler.jsonc`** in the repo is the v1 infrastructure-as-code; Wrangler `^4.147` (≥ 4.135 needed for Previews).
- `pnpm check` = lint + format:check + typecheck. Tests run separately.

## Consequences

- One command vocabulary for people, agents and CI.
- Dashboard-level resources (DNS, WAF, Hyperdrive configs) stay outside the repo until Terraform is justified.

## Notes (2026-10-14)

**ESLint 10.** `eslint` ^10.12 and `@eslint/js` ^10.0. The flat config needed no change; typescript-eslint 8.71, eslint-plugin-react-hooks 7.1 and eslint-config-prettier 10.1 accept ESLint 10 in their peer ranges, and the import-boundary rules still fire (checked with a probe importing `drizzle-orm` and `@saas-foundation/db/internal` from `apps/web/src`). The new recommended rules (`no-useless-assignment`, `preserve-caught-error`) found two spots in test code, fixed in the same PR. The decision above (ESLint flat config + Prettier) is unchanged; only the major moved.

## Notes (2026-10-15)

**Lint boundaries are tested.** `scripts/lint-boundaries.test.mjs` (Node's test runner, run by `pnpm lint`) lints virtual fixtures through the real flat config with the `ESLint` API and checks that each import restriction fires with its own message and that allowed imports pass; a broken pattern now fails `pnpm check` instead of passing silently. A research probe also found that importing a workspace package's files by path (`../../packages/db/src/client.ts`, an absolute path, or through `node_modules/`) passed lint and `tsc` and reached the raw database client, so `apps/app/src` now imports workspace packages by name only (static, dynamic and type imports), and `import.meta.glob` is refused. dependency-cruiser was evaluated (it matches resolved paths) and not adopted: it can't express the `createDb` named-import rule or non-literal `import()`, so ESLint stays the one boundary tool.

## Notes (2026-10-21)

**Oxfmt replaces Prettier; ESLint is unchanged.** The R12 spike (`docs/research/oxc-r12/`) measured Oxfmt 0.74.0 against Prettier 3.9.10 on this repository: the same 235 formatted files (Astro, Markdown, YAML, JSON, CSS, TS/TSX, JS/MJS), the same ignores, and 3 files formatted differently (two TypeScript union aliases now one member per line, one CSS `font-family` list joined onto one line; no option maps to either). The format check fell from 4.71 s to 0.35 s and `pnpm check` from 32.13 s to 27.09 s (medians, local, warm); typecheck remains the largest step. `.oxfmtrc.json` came from `oxfmt --migrate=prettier` and carries `.prettierignore`'s patterns, including release-please's changelog (ADR-0029). Oxfmt is 0.x, so it's pinned exactly and updated in its own Dependabot PR. `apps/app/scripts/export-plans.ts` formats `plans.json` with Oxfmt's `format()` API, which doesn't read config files, so the script passes `.oxfmtrc.json`'s options and `oxfmt --check` confirms the result. `eslint-config-prettier` stays: it only switches off ESLint's stylistic rules. Prettier remains in the lockfile as a dependency of TanStack's router generator and the Astro language server, not of our scripts.

**Oxlint is deferred.** In the same spike, `eslint-plugin-oxlint`'s generated config switched off `no-restricted-imports` and `no-require-imports` (44 of 112 boundary fixtures failed), Oxlint's `no-restricted-imports` silently skipped the module-boundary and normalized-path patterns, `no-restricted-syntax` isn't implemented, and a safe hybrid gained nothing measurable on `pnpm check`. ESLint stays the one boundary tool; `docs/research/oxc-r12/oxlint-resume.md` holds the evidence, the approaches to try and the conditions for reopening.
