# Start a new product from the foundation

A product is its own repository and its own infrastructure, built from this foundation. Nothing from the foundation's accounts, databases, tokens or domains is reused. Product-specific choices go in the product repo (ADR-0027: the foundation only gets what a second product also needs).

Steps marked **owner** need dashboard or account access.

## 1. Repository

- Clone, keep the foundation as `upstream` so its fixes can be merged later (not a GitHub template, which drops history; not a fork, which stays tied to this repo):
  ```
  git clone https://github.com/aaronbruiz/saas-foundation.git <product>
  cd <product> && git remote rename origin upstream
  gh repo create <owner>/<product> --private   # empty, no README or license
  git remote add origin https://github.com/<owner>/<product>.git && git push -u origin main
  ```
- Later: `git fetch upstream && git merge upstream/main`. Keep product code in new directories and modules so these merges stay clean.
- Don't copy `.local/`, `.dev.vars` or any `.claude`/`.agents` settings from another checkout.
- The `@saas-foundation/*` package scope can stay; renaming it touches every import and makes upstream merges harder.

## 2. Replace environment-specific configuration

Every value below names a foundation resource. Replace each with the product's own (created in step 3), or remove it until the product needs it.

| Where                                                                                   | Value                                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/app/wrangler.jsonc`                                                               | `name`, `account_id`, `routes[].pattern` (custom domain), `hyperdrive[].id`, `send_email[].allowed_sender_addresses`; `placement.region` next to the product's database |
| `scripts/preview/prepare-config.mjs`                                                    | `WORKER_NAME`, the `EMAIL` sender address                                                                                                                               |
| `scripts/preview/lib.sh`                                                                | `PREVIEW_WORKER` default (`<product>-preview`)                                                                                                                          |
| `apps/docs/wrangler.jsonc`, `apps/docs/astro.config.mjs`                                | docs Worker `name` (`<product>-docs`), `routes[].pattern` (`docs.<product zone>`), `site`, title                                                                        |
| `.github/workflows/docs-deploy.yml`, `docs-rollback.yml`                                | the lock name `deploy-<product>-docs`                                                                                                                                   |
| `apps/site/wrangler.jsonc`, `apps/site/astro.config.mjs`, `apps/site/public/robots.txt` | site Worker `name` (`<product>-site`), `routes[].pattern` (the product's apex), `site`, the sitemap URL                                                                 |
| `apps/site/src/config.ts`, `apps/site/src/pages/`, `apps/site/src/data/prices.json`     | product name, copy, app/docs URLs, contact address, sign-up mode; display amounts equal to the provider's (ADR-0033)                                                    |
| `.github/workflows/site-deploy.yml`, `site-rollback.yml`                                | the lock name `deploy-<product>-site`                                                                                                                                   |
| `apps/app/src/routes/__root.tsx`, root `package.json` `name`                            | page title, workspace name                                                                                                                                              |
| `apps/app/src/modules/billing/policy.ts`                                                | plans, prices by price key, limits, trial (ADR-0020)                                                                                                                    |
| `apps/app/src/lib/legal.ts` and the legal pages                                         | operator, contact, subprocessors                                                                                                                                        |
| `README.md`                                                                             | product name and purpose                                                                                                                                                |
| `docs/runbooks/README.md`                                                               | resource names and dated rollout notes (they describe the foundation's production)                                                                                      |

Then `pnpm --filter app cf-typegen`. Search for leftovers (skips the `@saas-foundation/*` imports): `git grep -n -P -e '(?<!@)saas-foundation(?!/)' -e aaronlabr -- ':!pnpm-lock.yaml' ':!docs/adr'`. Test fixtures that only use the names as sample strings can stay. The ADRs keep the foundation's ids as history (step 8).

## 3. Provision independent infrastructure (owner)

Create new, never shared with the foundation or another product:

- **Cloudflare:** the product's zone and production hostname (ADR-0017); Worker `<product>` and preview Worker `<product>-preview`; docs preview Worker `<product>-docs-preview` (Hello World, with Settings → Domains & Routes → Preview URLs enabled; the docs Worker `<product>-docs` and its `docs.<zone>` custom domain come from one manual `pnpm --filter docs build && pnpm --filter docs exec wrangler deploy`, runbook "Docs"); production Hyperdrive config, caching off (ADR-0004); email sending domain (ADR-0024); Turnstile widget for the production hostname (ADR-0025); R2 bucket for database dumps with its lifecycle (ADR-0023); WAF rule `auth-login-burst` (ADR-0014).
- **Neon:** a production project and a **separate** preview project with a `preview-seed` branch (ADR-0011, ADR-0021). Consider a separate Neon organization per product: the plan is per organization (ADR-0026).
- **Polar:** the product's organization, sandbox first; products matching the price keys in `policy.ts` (ADR-0022).
- **Worker secrets** (`pnpm --filter app exec wrangler secret put <NAME>`; values never in chat or git): `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `BETTER_AUTH_URL`, `SIGNUP_ALLOWLIST`, `EMAIL_FROM` (the product's sender name and address), `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and for billing `BILLING_PROVIDER`, `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_SERVER`. What each one does: runbook sections Email, Turnstile, Polar and First production deploy.

## 4. GitHub environments, secrets and variables (owner)

Environments `production`, `preview-infra`, `preview`, `docs` and `docs-preview`, each limited to deployment branch `main`. No secret at repository level (ADR-0013, ADR-0019, ADR-0021). Scopes and token permissions: runbook "CI credentials".

| Environment     | Secrets                                                                                                                                                                               | Variables                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `production`    | `CLOUDFLARE_API_TOKEN` (Workers Editor on `<product>` only), `NEON_API_KEY` (production project only), `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`, `R2_BACKUP_ENDPOINT` | `NEON_PROJECT_ID`, `R2_BACKUP_BUCKET`, `BACKUP_KEEP`, `NEON_DATABASE`, `NEON_ROLE` (optional; default `app`, `app_owner`) |
| `preview-infra` | `CLOUDFLARE_PREVIEW_INFRA_TOKEN` (Hyperdrive Edit only), `NEON_PREVIEW_API_KEY`                                                                                                       | `CLOUDFLARE_ACCOUNT_ID`, `NEON_PREVIEW_PROJECT_ID`, `NEON_PREVIEW_PARENT_BRANCH`, `NEON_DATABASE`, `NEON_ROLE`            |
| `preview`       | `CLOUDFLARE_API_TOKEN` (Workers Editor on `<product>-preview` only), `NEON_PREVIEW_API_KEY`                                                                                           | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, `NEON_PREVIEW_PROJECT_ID`, `NEON_DATABASE`, `NEON_ROLE`          |
| `docs`          | `CLOUDFLARE_DOCS_TOKEN` (Workers Editor on `<product>-docs` only)                                                                                                                     | `CLOUDFLARE_ACCOUNT_ID`                                                                                                   |
| `docs-preview`  | `CLOUDFLARE_DOCS_PREVIEW_TOKEN` (Workers Editor on `<product>-docs-preview` only)                                                                                                     | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`                                                                   |

Check the names against `grep -ohE '(secrets|vars)\.[A-Z0-9_]+' .github/workflows/*.yml | sort -u` and each workflow's `environment:`; the workflows are the source of truth. Repository-level (no environment), optional: `RELEASE_HOLD=true` holds a push-triggered release at 0% (runbook "Releases" step 3).

Repository settings (ADR-0029, ADR-0030): squash merge only, with the PR title as the commit message and a blank body; delete head branches on merge; immutable releases; Actions → Workflow permissions → **Allow GitHub Actions to create and approve pull requests** (default token read-only), which release-please needs to open the release PR. Before the first release, tag the commit production runs as `app-v0.1.0` and set it as `bootstrap-sha` in `.github/release-please-config.json` (ADR-0029 decision 1).

## 5. Verify, including tenant isolation

1. Local setup as in `README.md`: `pnpm install --frozen-lockfile`; `cp apps/app/.dev.vars.example apps/app/.dev.vars` and set a new `BETTER_AUTH_SECRET` (`openssl rand -base64 32`; the Turnstile test keys are in runbook "Turnstile"); `pnpm db:up`, `pnpm db:migrate`; `pnpm --filter app exec playwright install --with-deps chromium`. Then `pnpm check`, `pnpm test`, `pnpm test:e2e` all pass. If tests time out, see `README.md` "Troubleshooting".
2. Tenant isolation is covered by `apps/app/test/tenancy.test.ts`, `database-isolation.test.ts` and `roles.test.ts`, plus the E2E slice. They must pass unchanged. Every tenant-owned table the product adds gets cross-tenant tests for URL **and** server-function input (AGENTS.md recipe "Add a tenant-owned table").
3. Open a first PR: CI green, the preview deploys from its own Neon branch, and preview E2E passes.
4. Production: follow runbook "First production deploy" from step 0 with the product's values. The data gate (ADR-0014) and the launch milestones apply to each product separately.

## 6. Build the first feature

The projects feature is the complete pattern for a tenant-owned resource; copy its shape rather than starting from scratch:

| Layer                     | Projects                                                                              | Shows                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Table                     | `packages/db/src/schema/projects.ts`                                                  | `organization_id`, FK, index leading with it                                                           |
| Repository                | `projects()` in `packages/db/src/tenancy.ts`                                          | every statement in `inTenant`, filtered by `ctx.orgId`; `createWithinLimit` (limit under the row lock) |
| Input schemas             | `packages/contracts/src/index.ts` (`ProjectRef`, `CreateProjectInput`, …)             | `tenant: TenantSlug`, never `organizationId`                                                           |
| Service, server functions | `apps/app/src/modules/projects/{service,functions}.ts`                                | `getTenantContext`, 404 before `authorize`, capabilities                                               |
| Pages                     | `apps/app/src/routes/t.$tenant.projects.index.tsx`, `t.$tenant.projects.$id.tsx`      | loaders, `method="post"` forms disabled until hydrated                                                 |
| Tests                     | `apps/app/test/tenancy.test.ts`, `roles.test.ts`, `billing.test.ts` ("plan limits …") | cross-tenant by URL and by input, one case per role, the cap                                           |

Then follow the AGENTS.md recipes in order: "Add a tenant-owned table" (including child tables), "Add a tenant-scoped server function", and "Add a plan limit or feature" if it has one. The checks name most missed steps: `pnpm db:check` prints the `sql-only-objects.tsv` line, the catalog tests fail without the grant or the archive trigger, `pnpm check` fails on a stale `plans.json` (`pnpm plans:export`) or route tree (`pnpm build`).

E2E: a local run signs in from one IP, and the login rate limit (5 sign-ins and 5 sign-ups a minute per IP, ADR-0005, no test exemption) caps a run's real sign-ins. They're kept for the tests about signing up and signing in: a run uses 4 sign-ups and 5 sign-ins locally. A test that only needs someone signed in starts from the shared session instead (`test.use({ storageState: sessionFile })`, from `apps/app/e2e/session.ts`; `e2e/projects.spec.ts` is an example). The `setup` project (`e2e/auth.setup.ts`) signs that user up once per run; the user has no organization yet, so the test creates its own with `createOrg` (`e2e/helpers.ts`) and doesn't rely on other tests' data. A new test that signs in for real costs budget: if the full run fails with "Too many requests", it has run out.

## 7. Document the product

Product documentation lives in `docs/product/` ([ADR-0041](../adr/0041-product-owned-documentation-and-agent-instructions.md)). The foundation ships no file there and never edits it, so upstream merges don't touch it. Write each file when its trigger arrives:

- **`docs/product/overview.md`**, before the first feature merges: target users and which organization role they hold; the problems the product solves; 3–7 core workflows, each naming its module or route; what's in scope; non-goals; links to the product ADRs. It's the living description of the product, updated by the PRs that add or remove a user-visible workflow.
- **`docs/product/glossary.md`**, before the first feature merges: each product concept explained in a sentence or two. Where it helps, add its relation to foundation terms (owned by an organization or a user, the capability that guards it, the entitlement that limits it) and synonyms to avoid; those are optional. The PR that introduces or renames a term edits its entry.
- **`docs/product/architecture.md`**, when the first product service, integration or changed foundation default lands: each added service and integration with its responsibility, decision and config (like the table in [`docs/architecture/README.md`](../architecture/README.md)); each changed foundation default with the product ADR that supersedes it; each new deployable with its ADR-0027 checklist.
- **`docs/product/AGENTS.md`**, when the product has rules agents must follow: module map rows for the product's modules, product rules, and product checks for reviews. The root `AGENTS.md` loads it through its "Product instructions" line, so keep that line when merging upstream. Its rules add to the root file's and never override the invariants; keep it short, since every agent session reads it.

`docs/product/` reduces upstream conflicts but doesn't remove them: product edits to foundation-owned files (code, `wrangler.jsonc`, workflows, `policy.ts`, `README.md`) can still conflict with `git merge upstream/main`.

## 8. Record product decisions

- Foundation ADRs stay as they are: they're the product's history too. A product decision that differs gets a **new ADR in the product repo** naming the one it amends or supersedes (ADR README convention). Don't edit the inherited ones except to mark them superseded, as the ADR README allows.
- Product ADRs record decisions and deviations from the foundation; the product overview (step 7) describes the product and isn't an ADR. First product ADRs, typically: any foundation default the product changes (plan, region, sign-up mode); any new deployable or runtime (ADR-0027 criteria and checklist).
- A fix or pattern that every product needs goes back to the foundation as a PR there, then reaches products through `git merge upstream/main`.
