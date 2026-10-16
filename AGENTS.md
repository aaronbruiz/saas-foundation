# AGENTS.md

Multi-tenant SaaS on Cloudflare Workers. **One app Worker** (`apps/app`, TanStack Start + Workers Static Assets, placed near the DB in `aws:us-east-1`; the public docs site `apps/docs` and the marketing site `apps/site` are separate assets-only Workers, ADR-0028 and ADR-0033) talks to **Neon PostgreSQL through Hyperdrive** (caching off). Better Auth handles identity and organizations; authorization is our own code. Tenants are addressed by path: `/t/<slug>/…`. Architecture: `docs/architecture/`. Decisions: `docs/adr/`. Read the relevant ADR before changing anything it covers. Accepted ADRs are binding until a later ADR supersedes them; a significant new architectural choice (a runtime, deployable, data store, trust boundary or repo-wide convention) gets an ADR in the same PR.

## Module map

| Path                                 | Owns                                                                                                                                                                                                                                                                   | May import                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/app/src/routes/t.$tenant*.tsx` | tenant-scoped pages and loaders                                                                                                                                                                                                                                        | `modules/`, `server/`, `@saas-foundation/contracts`                               |
| `apps/app/src/routes/api/auth/$.ts`  | Better Auth handler                                                                                                                                                                                                                                                    | `@saas-foundation/auth`                                                           |
| `apps/app/src/server/context.ts`     | `getTenantContext(db, headers, slug)`: session → slug → org → membership                                                                                                                                                                                               | `@saas-foundation/auth`, `@saas-foundation/db`                                    |
| `apps/app/src/server/auth.ts`        | Better Auth per request (`authFor`): sign-up gate, email verification, Turnstile, owner-change billing hooks                                                                                                                                                           | `@saas-foundation/auth`, `@saas-foundation/db`, `modules/billing/{config,policy}` |
| `apps/app/src/server/permissions.ts` | role → capability matrix; `authorize(ctx, capability)` (403)                                                                                                                                                                                                           | nothing internal                                                                  |
| `apps/app/src/modules/<domain>/`     | domain logic and server functions                                                                                                                                                                                                                                      | `server/`, `@saas-foundation/db`, `@saas-foundation/contracts`                    |
| `apps/app/src/modules/billing/`      | **`policy.ts` is the product's billing policy** (plans, prices by price key, limits, features, trial, lifecycle; ADR-0020); entitlements, webhook, checkout/portal; `providers/polar` is the only place that knows Polar (merchant of record, ADR-0022)                | `server/`, `@saas-foundation/db`, `@saas-foundation/contracts`                    |
| `packages/db`                        | Drizzle schema, migrations, client factory, **tenant-scoped repositories**                                                                                                                                                                                             | nothing internal                                                                  |
| `packages/auth`                      | Better Auth config (server only)                                                                                                                                                                                                                                       | `@saas-foundation/db`                                                             |
| `packages/contracts`                 | Zod schemas shared by UI and server                                                                                                                                                                                                                                    | nothing internal                                                                  |
| `apps/docs`                          | public product docs (Astro + Starlight, static; ADR-0028): pages in `src/content/docs/`, `llms.txt` and `.md` twins in `src/pages/`; no bindings, secrets or tenant data                                                                                               | nothing internal                                                                  |
| `apps/site`                          | public marketing site on the apex (Astro, static; ADR-0033): landing, pricing from `src/data/plans.json` (generated from `billing/policy.ts`, `pnpm plans:export`) and `prices.json` (display amounts); links to the app; no bindings, secrets, scripts or tenant data | nothing internal (JSON data only)                                                 |

A `Db` is an opaque handle: only `packages/db` repositories can query through it. The raw Drizzle client (`rawDb(db)`) and `schema` come from `@saas-foundation/db/internal`, for `packages/auth` (Better Auth's adapter) and tests only.

The import boundaries above are enforced by `eslint.config.js`, along with raw database access in `apps/app/src`: `drizzle-orm` and `@saas-foundation/db/internal` are never imported, `createDb` only in `server/db.ts` and `server/health.ts`, and routes and components (except `routes/api/auth/`) don't import `server/db` (static or `import()`). In `apps/app/src`, import paths are normalized (no `//`, inner `./` or `a/../`), `import()` takes a string literal, workspace packages are imported by name (never by a `../` or absolute path through `packages/` or `node_modules/` such as `../packages/db/src/client.ts`, which skips their `exports`) and `import.meta.glob` isn't used, so these rules can check them. `scripts/lint-boundaries.test.mjs` (part of `pnpm lint`) proves each restriction fires with its own message; add a case when you add or change one. Tests in `apps/app/test` and `apps/app/e2e` may use `createDb`, `@saas-foundation/db/internal` and `drizzle-orm`.

## Commands

```
pnpm db:up         # start local Postgres (docker compose; dev DB `app`, test DB `app_test`)
pnpm dev           # local Worker on http://localhost:3000 (strict port); DB via Hyperdrive localConnectionString
pnpm check         # lint (ESLint v10) + format:check (Prettier) + typecheck (tsc --noEmit)
pnpm test          # Vitest 4 inside workerd (@cloudflare/vitest-plugin), against `app_test`
pnpm format        # apply Prettier
pnpm build         # production build
pnpm db:generate   # drizzle-kit: schema → new migration SQL (review it)
pnpm db:migrate    # apply migrations (DATABASE_URL, default local `app`)
pnpm db:check      # migrations: applied ones unchanged vs origin/main, no collision, none missing, schema/auth.ts current, SQL builds the schema (CI runs it)
pnpm auth:generate # regenerate packages/db/src/schema/auth.ts from the Better Auth config, then db:generate
pnpm test:e2e      # Playwright: full slice + isolation (starts `pnpm dev`, locally and in CI; preview.yml also runs `main`'s suite against the PR preview)
pnpm --filter docs dev | build   # docs site (ADR-0028) on http://localhost:4321 | static build to apps/docs/dist; CI: docs.yml
pnpm --filter site dev | build   # marketing site (ADR-0033) on http://localhost:4322 | static build to apps/site/dist; CI: site.yml
pnpm plans:export  # regenerate apps/site/src/data/plans.json after changing billing/policy.ts (`pnpm check` fails until you do)
scripts/preview/infra.sh up|down | deploy-artifact.sh | down.sh   # per-PR preview lifecycle; run by CI (ADR-0021)
scripts/backup/snapshot.sh | dump.sh   # daily Neon snapshot branch + off-provider pg_dump to R2; run by CI (db-backup.yml; ADR-0003, ADR-0023)
scripts/sites/*.sh   # static sites (SITE=docs|site): build checks, PR preview, production deploy, rollback; run by CI (docs*.yml, site*.yml calling the shared static-*.yml; ADR-0028, ADR-0033)
scripts/release/*.sh   # production release (preflight, restore point, migrate, 0% candidate, promote) and rollback steps; run by CI (release.yml, rollback.yml; ADR-0029)
```

Toolchain: Node 24, pnpm (version pinned in `package.json`), TypeScript `~6.0` (TS 7 isn't supported by typescript-eslint), Vitest `^4.1` (`@cloudflare/vitest-plugin` doesn't support Vitest 5 yet). Docs and site: Astro 7 and Starlight pinned exactly while it's 0.x (own Dependabot group, with `@astrojs/*` and `prettier-plugin-astro`); `astro check` is their typecheck. Dependabot (`.github/dependabot.yml`) skips these majors and `@types/node` above 24; change its `ignore` list when a pin changes.

**Port 3000 busy:** `pnpm dev` uses `--strictPort` and fails if port 3000 is taken (auth origins depend on it). Don't switch ports and don't kill processes yourself. Stop and tell the user that port 3000 is in use, and recommend they free it with:

```
kill -9 $(lsof -t -i:3000)
```

## Invariants (non-negotiable)

1. The tenant comes from the `/t/<slug>` route param or a **Zod-validated `tenant` input on server functions**, and is **verified against membership on every request** via `getTenantContext`. The slug is a selector, never an authority. `activeOrganizationId` only picks the landing page.
2. Tenant data is accessed **only via repository functions in `packages/db`** that take `ctx.orgId`. No Drizzle calls in routes or components.
3. `packages/db` owns every table; modules reach data only through its repository functions. A module uses another module only through that module's **public entry points** (today `billing/entitlements` and `billing/policy`), never its internals (services, server functions, webhook, providers). New entry points are added to `publicEntryPoints` in `eslint.config.js`, which enforces this.
4. Authorization is decided on the server. The UI may hide things, never decide them.
5. Unknown tenant, non-member, or another tenant's resource returns **404**, never 403, and never leaks data. **403** is only for a member of the tenant whose role is insufficient (e.g. a `member` inviting), since the tenant's existence is already known to them.
6. Authorization reads **entitlements** (`entitlementsIn(db, ctx.orgId)`) only, never subscription status or Polar objects. Only `modules/billing/providers/**` may import a provider SDK (`@polar-sh/*`) or reference provider ids. Product billing rules (plans, limits, features, which statuses keep access) live only in `modules/billing/policy.ts`; enforcement points ask it and never name a plan (ADR-0020).
7. The only DB binding is `DB` (Hyperdrive, **caching disabled**). Don't add a cached binding without an ADR. The app connects as the least-privilege role `app_runtime` (locally and in tests now; production after ADR-0038's runbook steps); migrations, backups and previews use the owner `app_owner`. No default privileges: every table's runtime grants are explicit.
8. Secrets come only from Worker `env`. `.dev.vars` is git-ignored. Nothing secret goes in client code (CI scans the client bundle: `scripts/scan-client-bundle.sh`). Forms use `method="post"` and stay disabled until hydrated, so fields never reach a URL.
9. Every server boundary validates input with Zod from `packages/contracts`. `organizationId` is never an input field.
10. Migrations are generated by drizzle-kit, reviewed, forward-safe (expand → migrate → contract), and **never edited after being applied**. CI enforces this (`scripts/check-migrations.mjs`, `scripts/check-schema-sql.sh`): drizzle's migrator silently skips an edited or out-of-order migration on existing databases while fresh ones apply it.
11. Webhooks are verified on the raw body (`await request.text()`) before any processing, and deduplicated by event id.
12. Async side effects are idempotent with dedupe keys (once queues exist).
13. Infra config (`wrangler.jsonc`) changes only via PR.
14. **No new Cloudflare binding, product or Worker without a new ADR naming its trigger.** Every storage binding also needs a `previews` override (except ADR-0035's temporary recovery-drill Workers, which create no Previews). CI (`scripts/check-bindings.mjs`) enforces the ADR for any new binding, product or Worker name in `apps/app/wrangler.jsonc` (including `previews`), refuses any other Wrangler config except the assets-only `apps/docs/wrangler.jsonc` and `apps/site/wrangler.jsonc` (no `main`, binding, `vars`, `env` or `previews`; ADR-0028, ADR-0033), refuses named environments, and requires the override for KV, R2, D1, Hyperdrive and Vectorize; any other data binding's ADR must state how previews stay isolated.
15. Previews never bind production data. Each PR gets its **own** Neon branch `preview/pr-N` in the **separate preview project** (reset from `preview-seed` on every deploy) and its **own** Hyperdrive config `saas-pr-N`, never reused between PRs; deleting that config on close is what revokes database access (ADR-0021). Only default-branch jobs in `main`-only environments create or delete them, and no job runs PR code next to a preview credential or holds both the Worker and the Hyperdrive token.

## Recipes

**Add a tenant-owned table:** `organization_id` NOT NULL + FK to `organization.id` + an index that leads with `organization_id` → add repository functions in `packages/db/src/<table>.ts` that filter by `ctx.orgId` on every read, update and delete → add a Zod schema without `organizationId` → add cross-tenant tests (URL **and** server-function input) → `pnpm db:generate` → review the SQL → grant `app_runtime` only the privileges it needs in a `drizzle-kit generate --custom` migration and add the table to `GRANTS` in `apps/app/test/database-role.test.ts` (ADR-0038).

**Add a plan limit or feature (ADR-0020):** add it to `Entitlements` and every plan in `modules/billing/policy.ts` → enforce it where the resource is created, asking `entitlementsIn(db, ctx.orgId)` (a count-then-insert needs the organization row lock, like `projects.createWithinLimit`) → tests for the cap, upgrade, downgrade (nothing deleted) and concurrency.

**Add a tenant-scoped server function:** input schema includes `tenant: TenantSlug` → parse the input, then first inside `withDb`: `const ctx = await getTenantContext(db, headers, tenant)` → for an operation on a resource id, first confirm the resource exists in this tenant (404) → `authorize(ctx, '<capability>')` (add the capability to the matrix in `server/permissions.ts` and a test per role in `test/roles.test.ts`) → call repositories with `ctx`.

**Add a Cloudflare binding:** write `docs/adr/NNNN-<binding>.md` (trigger, alternatives, preview isolation) → add it to `wrangler.jsonc` **and** its `previews` block → `pnpm --filter app cf-typegen`.

**Add a deployable or another runtime (ADR-0027):** write its ADR against ADR-0027's criteria and checklist → `apps/<name>/` with its native manifest → no tenant database access unless that ADR chooses and reviews a boundary.

## Git workflow (ADR-0030)

- Trunk-based: short-lived branches named `<type>/<scope>-<description>` off `main`, merged within about two days. No release branches; fix forward (in an emergency, roll back first, ADR-0029).
- **The PR title is a Conventional Commit**: `<type>(<scope>)!: <description>`, types `feat fix perf refactor revert docs test chore ci build`, scope optional and lowercase, at most 100 characters, `!` = breaking (mainly a contract migration). `pr-title.yml` checks it, and fails a PR whose migration drops, renames, moves or retypes anything, or contains an SQL comment other than drizzle-kit's `--> statement-breakpoint` (fail-closed), unless its title has `!` (ADR-0029 decision 7). Squash merge only: the PR title becomes the commit on `main` (body blank), and release-please reads it (ADR-0029).
- **The PR description is the spec** (`.github/pull_request_template.md`): Goal, Behaviour (including failure cases), Out of scope, Checks. For non-trivial work, write it before the code.
- Stacks at most 3 deep. Update a child by merging its base into it (no rebase and force-push). Merged branches are deleted automatically, and GitHub then retargets a stacked child to the merged PR's base (tested 2026-10-13, ADR-0030 Notes). Never delete a base branch by hand; if a child needs retargeting, use `gh api -X PATCH repos/<owner>/<repo>/pulls/N -f base=main`.
- Tests are named for the behaviour they prove ("a non-member gets 404 on another tenant's overview"); no Gherkin.
- No branch protection (GitHub Free): the owner merges only when CI is green.

## Do not edit

- `packages/db/src/schema/auth.ts`: generated by the Better Auth CLI (`pnpm auth:generate`, the `auth` CLI pinned in `packages/auth`); regenerate instead
- migrations that have already been applied
- generated files: `routeTree.gen.ts`, `worker-configuration.d.ts`. Regenerate them.

## Done means

`pnpm check`, `pnpm test` and `pnpm test:e2e` pass, a cross-tenant test exists for any new tenant data, the ADR and this file are updated in the same PR if the architecture changed, a Codex review is clean after any corrections, and a human approves the merge.

## Code Review Rules

Review for behaviour and security. Formatting, lint and types are CI's job. Flag:

- Any data access to tenant tables that doesn't go through a `packages/db` repository function taking `ctx.orgId`.
- Any server function or route touching tenant data **without** calling `getTenantContext`, or that trusts a slug, `organizationId` or `activeOrganizationId` from the client.
- Responses that return 403 (instead of 404) or distinguish "exists but forbidden" for another tenant's resources. (403 for a member with an insufficient role in their own tenant is intended.)
- Authorization or feature gating that reads subscription status or Polar/provider objects instead of entitlements; `@polar-sh/*` imported outside `modules/billing/providers/**`.
- Migrations that drop, rename or retype columns in one step; edits to already-applied migrations.
- Database privileges (ADR-0038): `ALTER DEFAULT PRIVILEGES`, a grant to `app_runtime` beyond what the code needs, a new table without its grant migration and `GRANTS` entry, or app code connecting as the owner.
- Code or configuration contradicting an Accepted ADR, flagged with the relevant `ADR-NNNN`. Significant architectural decisions without an ADR, flagged for documentation and approval before the change is accepted.
- New bindings in `wrangler.jsonc` without an ADR, or without a `previews` override.
- Reads that need freshness routed through any cached path; secrets reachable from client code.
- A plan name, price id, limit number or subscription status checked outside `modules/billing/policy.ts` (product assumptions spread through the app, ADR-0020); a limit enforced only in our service when Better Auth's own endpoints can bypass it.
- Webhook handlers that parse JSON before verifying the signature, or that aren't idempotent; a billing webhook that works without its secret configured, or that lets an older or duplicate event change state (ADR-0018).
- A Polar subscription event applied from its payload alone (instead of the re-read subscription), or linked to an organization unless its `metadata.organization_id` equals the customer's `external_id`; Polar mode inferred from a token instead of `BILLING_PROVIDER=polar` (ADR-0022).
- An owner change (role update, removal, leave, organization deletion) that bypasses Better Auth's organization hooks, or a failed Polar revoke or customer removal that doesn't refuse the change (revoke before, grant after; ADR-0022).
- New tenant data without cross-tenant tests.
- Email sent outside `server/email.ts`'s `Mailer`, a token placed in a URL path instead of the query string, or `EMAIL_DELIVERY=console` reachable outside localhost (ADR-0016).
- Logging request bodies, headers, cookies, tokens, connection strings or user data (emails, names) anywhere; server-side logs go through `server/log.ts` with a stable `event` name (ADR-0015).
- A server function that changes tenant data without `authorize(ctx, …)`, role checks written inline instead of through the capability matrix, or a matrix change without per-role tests.
- Sign-in/sign-up done through `auth.api.*` server calls instead of the `/api/auth/*` HTTP handler (bypasses login rate limiting, ADR-0005), or changes to `rateLimit` / `advanced.ipAddress` without updating ADR-0005.
- A way to skip Turnstile (ADR-0025): an unauthenticated endpoint that signs in, creates an account or sends email missing from `BOT_PROTECTED_PATHS`, a test key accepted outside localhost/workers.dev, a missing key that skips the check instead of refusing, or a captcha token sent anywhere but the `x-captcha-response` header.
- A PR that breaks ADR-0030's reviewed rules: non-trivial work without a spec (Goal, Behaviour, Out of scope, Checks) in its description, a branch not named `<type>/<scope>-<description>`, a stack deeper than 3, or tests named after the implementation instead of the behaviour.

Safe to ignore: generated files (`schema/auth.ts`, `routeTree.gen.ts`, `worker-configuration.d.ts`).
