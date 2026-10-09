# Start a new product from the foundation

A product is its own repository and its own infrastructure, built from this foundation. Nothing from the foundation's accounts, databases, tokens or domains is reused. Product-specific choices go in the product repo (ADR-0027: the foundation only gets what a second product also needs).

Steps marked **owner** need dashboard or account access.

## 1. Repository

- Clone, keep the foundation as `upstream` so its fixes can be merged later (not a GitHub template, which drops history; not a fork, which stays tied to this repo):
  ```
  git clone https://github.com/aaronbruiz/saas-foundation.git <product>
  cd <product> && git remote rename origin upstream
  git remote add origin https://github.com/<owner>/<product>.git && git push -u origin main
  ```
- Later: `git fetch upstream && git merge upstream/main`. Keep product code in new directories and modules so these merges stay clean.
- Don't copy `.local/`, `.dev.vars` or any `.claude`/`.agents` settings from another checkout.
- The `@saas-foundation/*` package scope can stay; renaming it touches every import and makes upstream merges harder.

## 2. Replace environment-specific configuration

Every value below names a foundation resource. Replace each with the product's own (created in step 3), or remove it until the product needs it.

| Where                                                        | Value                                                                                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/wrangler.jsonc`                                    | `name`, `account_id`, `routes[].pattern` (custom domain), `hyperdrive[].id`, `send_email[].allowed_sender_addresses`; `placement.region` next to the product's database |
| `scripts/preview/prepare-config.mjs`                         | `WORKER_NAME`, the `EMAIL` sender address                                                                                                                               |
| `scripts/preview/lib.sh`                                     | `PREVIEW_WORKER` default (`<product>-preview`)                                                                                                                          |
| `apps/web/src/routes/__root.tsx`, root `package.json` `name` | page title, workspace name                                                                                                                                              |
| `apps/web/src/modules/billing/policy.ts`                     | plans, prices by price key, limits, trial (ADR-0020)                                                                                                                    |
| `apps/web/src/lib/legal.ts` and the legal pages              | operator, contact, subprocessors                                                                                                                                        |
| `README.md`, `docs/architecture/README.md`                   | product name and purpose                                                                                                                                                |
| `docs/runbooks/README.md`                                    | resource names and dated rollout notes (they describe the foundation's production)                                                                                      |

Then `pnpm --filter web cf-typegen`. Search for leftovers (skips the `@saas-foundation/*` imports): `git grep -n -P -e '(?<!@)saas-foundation(?!/)' -e aaronlabr -- ':!pnpm-lock.yaml' ':!docs/adr'`. Test fixtures that only use the names as sample strings can stay. The ADRs keep the foundation's ids as history (step 6).

## 3. Provision independent infrastructure (owner)

Create new, never shared with the foundation or another product:

- **Cloudflare:** the product's zone and production hostname (ADR-0017); Worker `<product>` and preview Worker `<product>-preview`; production Hyperdrive config, caching off (ADR-0004); email sending domain (ADR-0024); Turnstile widget for the production hostname (ADR-0025); R2 bucket for database dumps with its lifecycle (ADR-0023); WAF rule `auth-login-burst` (ADR-0014).
- **Neon:** a production project and a **separate** preview project with a `preview-seed` branch (ADR-0011, ADR-0021). Consider a separate Neon organization per product: the plan is per organization (ADR-0026).
- **Polar:** the product's organization, sandbox first; products matching the price keys in `policy.ts` (ADR-0022).
- **Worker secrets** (`pnpm --filter web exec wrangler secret put <NAME>`; values never in chat or git): `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `BETTER_AUTH_URL`, `SIGNUP_ALLOWLIST`, `EMAIL_FROM` (the product's sender name and address), `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and for billing `BILLING_PROVIDER`, `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_SERVER`. What each one does: runbook sections Email, Turnstile, Polar and First production deploy.

## 4. GitHub environments, secrets and variables (owner)

Environments `production`, `preview-infra` and `preview`, each limited to deployment branch `main`. No secret at repository level (ADR-0013, ADR-0019, ADR-0021). Scopes and token permissions: runbook "CI credentials".

| Environment     | Secrets                                                                                                                  | Variables                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `production`    | `NEON_API_KEY` (production project only), `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`, `R2_BACKUP_ENDPOINT` | `NEON_PROJECT_ID`, `R2_BACKUP_BUCKET`, `BACKUP_KEEP`                                                             |
| `preview-infra` | `CLOUDFLARE_PREVIEW_INFRA_TOKEN` (Hyperdrive Edit only), `NEON_PREVIEW_API_KEY`                                          | `CLOUDFLARE_ACCOUNT_ID`, `NEON_PREVIEW_PROJECT_ID`, `NEON_PREVIEW_PARENT_BRANCH`, `NEON_DATABASE`, `NEON_ROLE`   |
| `preview`       | `CLOUDFLARE_API_TOKEN` (Workers Editor on `<product>-preview` only), `NEON_PREVIEW_API_KEY`                              | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, `NEON_PREVIEW_PROJECT_ID`, `NEON_DATABASE`, `NEON_ROLE` |

Check the names against `grep -ohE '(secrets|vars)\.[A-Z0-9_]+' .github/workflows/*.yml | sort -u` and each workflow's `environment:`; the workflows are the source of truth.

## 5. Verify, including tenant isolation

1. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, then `pnpm check`, `pnpm test`, `pnpm test:e2e` all pass locally.
2. Tenant isolation is covered by `apps/web/test/tenancy.test.ts`, `database-isolation.test.ts` and `roles.test.ts`, plus the E2E slice. They must pass unchanged. Every tenant-owned table the product adds gets cross-tenant tests for URL **and** server-function input (AGENTS.md recipe "Add a tenant-owned table").
3. Open a first PR: CI green, the preview deploys from its own Neon branch, and preview E2E passes.
4. Production: follow runbook "First production deploy" from step 0 with the product's values. The data gate (ADR-0014) and the launch milestones apply to each product separately.

## 6. Record product decisions

- Foundation ADRs stay as they are: they're the product's history too. A product decision that differs gets a **new ADR in the product repo** naming the one it amends or supersedes (ADR README convention). Don't edit the inherited ones.
- First product ADRs, typically: what the product is and its non-goals; any foundation default it changes (plan, region, sign-up mode); any new deployable or runtime (ADR-0027 criteria and checklist).
- A fix or pattern that every product needs goes back to the foundation as a PR there, then reaches products through `git merge upstream/main`.
