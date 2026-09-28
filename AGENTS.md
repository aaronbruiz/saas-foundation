# AGENTS.md

Multi-tenant SaaS on Cloudflare Workers. **One deployable Worker** (`apps/web`, TanStack Start + Workers Static Assets, placed near the DB in `aws:us-east-1`) talks to **Neon PostgreSQL through Hyperdrive** (caching off). Better Auth handles identity and organizations; authorization is our own code. Tenants are addressed by path: `/t/<slug>/…`. Architecture: `docs/architecture/`. Decisions: `docs/adr/`. Read the relevant ADR before changing anything it covers.

## Module map

| Path                                | Owns                                                                         | May import                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/web/src/routes/t/$tenant/`    | tenant-scoped pages and loaders                                              | `modules/`, `server/`, `@saas-foundation/contracts`            |
| `apps/web/src/routes/api/auth/$.ts` | Better Auth handler                                                          | `@saas-foundation/auth`                                        |
| `apps/web/src/server/context.ts`    | `getTenantContext(request, env, slug)`: session → slug → org → membership    | `@saas-foundation/auth`, `@saas-foundation/db`                 |
| `apps/web/src/modules/<domain>/`    | domain logic and server functions                                            | `server/`, `@saas-foundation/db`, `@saas-foundation/contracts` |
| `apps/web/src/modules/billing/`     | plans → entitlements; `providers/stripe` is the only place that knows Stripe | `@saas-foundation/db`, `@saas-foundation/contracts`            |
| `packages/db`                       | Drizzle schema, migrations, client factory, **tenant-scoped repositories**   | nothing internal                                               |
| `packages/auth`                     | Better Auth config (server only)                                             | `@saas-foundation/db`                                          |
| `packages/contracts`                | Zod schemas shared by UI and server                                          | nothing internal                                               |
| `packages/testkit`                  | fixtures, seeded tenants, login helpers                                      | anything (tests only)                                          |

The import boundaries above are enforced by `eslint.config.js`.

## Commands

```
pnpm db:up         # start local Postgres (docker compose; dev DB `app`, test DB `app_test`)
pnpm dev           # local Worker on http://localhost:3000 (strict port); DB via Hyperdrive localConnectionString
pnpm check         # lint (ESLint v9) + format:check (Prettier) + typecheck (tsc --noEmit)
pnpm test          # Vitest 4 inside workerd (@cloudflare/vitest-plugin), against `app_test`
pnpm format        # apply Prettier
pnpm build         # production build
pnpm db:generate   # drizzle-kit: schema → new migration SQL (review it)
pnpm db:migrate    # apply migrations (DATABASE_URL, default local `app`)
pnpm auth:generate # regenerate packages/db/src/schema/auth.ts from the Better Auth config, then db:generate
pnpm test:e2e      # Playwright: full slice + isolation (local: starts `pnpm dev`; CI: against the PR preview)
scripts/preview/up.sh | down.sh   # per-PR preview lifecycle; normally run by CI (PR_NUMBER=<n>)
```

Toolchain: Node 24, pnpm (version pinned in `package.json`), TypeScript `~6.0` (TS 7 isn't supported by typescript-eslint), Vitest `^4.1` (`@cloudflare/vitest-plugin` doesn't support Vitest 5 yet).

**Port 3000 busy:** `pnpm dev` uses `--strictPort` and fails if port 3000 is taken (auth origins depend on it). Don't switch ports and don't kill processes yourself. Stop and tell the user that port 3000 is in use, and recommend they free it with:

```
kill -9 $(lsof -t -i:3000)
```

## Invariants (non-negotiable)

1. The tenant comes from the `/t/<slug>` route param or a **Zod-validated `tenant` input on server functions**, and is **verified against membership on every request** via `getTenantContext`. The slug is a selector, never an authority. `activeOrganizationId` only picks the landing page.
2. Tenant data is accessed **only via repository functions in `packages/db`** that take `ctx.orgId`. No Drizzle calls in routes or components.
3. Modules don't touch other modules' tables; call the module's exports.
4. Authorization is decided on the server. The UI may hide things, never decide them.
5. Unknown tenant, non-member, or another tenant's resource returns **404**, never 403, and never leaks data. **403** is only for a member of the tenant whose role is insufficient (e.g. a `member` inviting), since the tenant's existence is already known to them.
6. Authorization reads **entitlements** (`getEntitlements(orgId)`) only, never subscription status or Stripe objects. Only `modules/billing/providers/**` may import `stripe` or reference provider ids.
7. The only DB binding is `DB` (Hyperdrive, **caching disabled**). Don't add a cached binding without an ADR.
8. Secrets come only from Worker `env`. `.dev.vars` is git-ignored. Nothing secret goes in client code (CI scans the client bundle: `scripts/scan-client-bundle.sh`). Forms use `method="post"` and stay disabled until hydrated, so fields never reach a URL.
9. Every server boundary validates input with Zod from `packages/contracts`. `organizationId` is never an input field.
10. Migrations are generated by drizzle-kit, reviewed, forward-safe (expand → migrate → contract), and **never edited after being applied**.
11. Webhooks are verified on the raw body (`await request.text()`) before any processing, and deduplicated by event id.
12. Async side effects are idempotent with dedupe keys (once queues exist).
13. Infra config (`wrangler.jsonc`) changes only via PR.
14. **No new Cloudflare binding, product or Worker without a new ADR naming its trigger.** Every storage binding also needs a `previews` override.
15. Previews never bind production data. Each PR gets its own Neon branch in the **separate preview project** (from `preview-seed`) and its own Hyperdrive config.

## Recipes

**Add a tenant-owned table:** `organization_id` NOT NULL + FK to `organization.id` + an index that leads with `organization_id` → add repository functions in `packages/db/src/<table>.ts` that filter by `ctx.orgId` on every read, update and delete → add a Zod schema without `organizationId` → add cross-tenant tests (URL **and** server-function input) → `pnpm db:generate` → review the SQL.

**Add a tenant-scoped server function:** input schema includes `tenant: TenantSlug` → first line `const ctx = await getTenantContext(request, env, input.tenant)` → call repositories with `ctx`.

**Add a Cloudflare binding:** write `docs/adr/NNNN-<binding>.md` (trigger, alternatives, preview isolation) → add it to `wrangler.jsonc` **and** its `previews` block → `pnpm --filter web cf-typegen`.

## Do not edit

- `packages/db/src/schema/auth.ts`: generated by the Better Auth CLI (`npx auth@latest generate`); regenerate instead
- migrations that have already been applied
- generated files: `routeTree.gen.ts`, `worker-configuration.d.ts`. Regenerate them.

## Done means

`pnpm check`, `pnpm test` and `pnpm test:e2e` pass, a cross-tenant test exists for any new tenant data, the ADR and this file are updated in the same PR if the architecture changed, a Codex review is clean after any corrections, and a human approves the merge.

## Code Review Rules

Review for behaviour and security. Formatting, lint and types are CI's job. Flag:

- Any data access to tenant tables that doesn't go through a `packages/db` repository function taking `ctx.orgId`.
- Any server function or route touching tenant data **without** calling `getTenantContext`, or that trusts a slug, `organizationId` or `activeOrganizationId` from the client.
- Responses that return 403 (instead of 404) or distinguish "exists but forbidden" for another tenant's resources. (403 for a member with an insufficient role in their own tenant is intended.)
- Authorization or feature gating that reads subscription status or Stripe/provider objects instead of entitlements; `stripe` imported outside `modules/billing/providers/**`.
- Migrations that drop, rename or retype columns in one step; edits to already-applied migrations.
- New bindings in `wrangler.jsonc` without an ADR, or without a `previews` override.
- Reads that need freshness routed through any cached path; secrets reachable from client code.
- Webhook handlers that parse JSON before verifying the signature, or that aren't idempotent.
- New tenant data without cross-tenant tests.
- Sign-in/sign-up done through `auth.api.*` server calls instead of the `/api/auth/*` HTTP handler (bypasses login rate limiting, ADR-0005), or changes to `rateLimit` / `advanced.ipAddress` without updating ADR-0005.

Safe to ignore: generated files (`schema/auth.ts`, `routeTree.gen.ts`, `worker-configuration.d.ts`).
