# Testing

How the foundation is tested, what each layer proves and how to test a product feature. Setup (Node, pnpm, Docker, `.dev.vars`) is in [`README.md`](../README.md); the rules every change keeps are in [`AGENTS.md`](../AGENTS.md) ("Done means", recipes). Terms: [glossary](glossary.md). A product's own fixtures or integration fakes, if any, are documented in its `docs/product/` ([ADR-0041](adr/0041-product-owned-documentation-and-agent-instructions.md)).

## Layers

| Layer               | Command                                                                                      | What it covers                                                                                                                                                                                                        | Config                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Worker tests        | `pnpm test`                                                                                  | server functions, repositories, auth, billing and database roles, inside workerd (`@cloudflare/vitest-plugin`) against the test database `app_test`, connected as `app_runtime`                                       | [`apps/app/vitest.config.ts`](../apps/app/vitest.config.ts), `apps/app/test/`                                                      |
| E2E                 | `pnpm test:e2e`                                                                              | the full slice in Chromium against a local dev server on port 3000 and the dev database `app`                                                                                                                         | [`apps/app/playwright.config.ts`](../apps/app/playwright.config.ts), `apps/app/e2e/`                                               |
| Script tests        | `pnpm lint` (after ESLint)                                                                   | lint boundary rules, secret, migration, catalog and AGENTS.md size checks (`node --test scripts/*.test.mjs`)                                                                                                          | root [`package.json`](../package.json)                                                                                             |
| Database checks     | `pnpm db:check`                                                                              | migrations: see [Database checks](#database-checks)                                                                                                                                                                   | [`scripts/check-migrations.mjs`](../scripts/check-migrations.mjs), [`scripts/check-schema-sql.sh`](../scripts/check-schema-sql.sh) |
| Polar sandbox evals | from `apps/app`: `POLAR_EVAL_RUN=<slug> pnpm exec vitest run --config vitest.eval.config.ts` | the Polar provider against Polar's sandbox; needs the `POLAR_*` keys in `apps/app/.dev.vars`; skipped without `POLAR_EVAL_RUN`; **not** part of `pnpm test` or CI                                                     | [`apps/app/vitest.eval.config.ts`](../apps/app/vitest.eval.config.ts), `apps/app/eval/`                                            |
| Preview E2E         | runs in CI                                                                                   | `main`'s E2E suite against the PR's preview deployment (`BASE_URL` set, no local server, email verification off); the workflow runs only default-branch code, so no PR code runs there (the PR's own tests ran in CI) | [`.github/workflows/preview.yml`](../.github/workflows/preview.yml)                                                                |

Both Vitest and Playwright need local Postgres: `pnpm db:up`. All clones on a machine share it, so run them through `scripts/test-lock.sh test|e2e`, which serializes runs and keeps each run's full output. It's one lock for all local test resources: it's named after `app_test`, and also guards E2E's dev database and port 3000. The Worker tests migrate `app_test` themselves (`test/global-setup.ts`); the E2E run refuses to start while the dev database has pending migrations (`pnpm db:migrate`). An expected warning on every Worker test run: `[vpw:warn] Failed to statically analyze the exports of the main Worker entry-point`.

## Fixtures

Worker tests (`apps/app/test/`):

- [`helpers.ts`](../apps/app/test/helpers.ts): `signUp`, `createOrg`, `joinAs` (a real invitation), `authPost` (through the real Better Auth HTTP handler), `expectStatus`, `onPaidPlan`, `entitlementsOf`. `randomIp` gives each simulated client its own IP: the login rate limit counts per IP (ADR-0005) and its rows persist in `app_test` across runs.
- [`turnstile-fake.ts`](../apps/app/test/turnstile-fake.ts): a local Turnstile siteverify (pass, fail, spent tokens, outages), installed for every file by `test/setup.ts` (ADR-0025).
- [`polar-webhook.ts`](../apps/app/test/polar-webhook.ts): signed Polar webhook deliveries and a stubbed Polar subscriptions API (ADR-0022).
- [`local-runtime-role.ts`](../apps/app/test/local-runtime-role.ts): gives `app_runtime` its local password, for local and CI Postgres only (ADR-0038).

E2E (`apps/app/e2e/`):

- [`auth.setup.ts`](../apps/app/e2e/auth.setup.ts) and [`session.ts`](../apps/app/e2e/session.ts): one real sign-up per run, saved as a shared session (`sessionFile`).
- [`fixtures.ts`](../apps/app/e2e/fixtures.ts): the `test` every spec imports (lint enforces it). It fails a test when any of its pages hits a Content-Security-Policy refusal, reported by the browser's `securitypolicyviolation` event or its console, in the `page` context and every `browser.newContext()` (ADR-0045). Only styles rendered on the server are refused; React sets client-side styles through the DOM, which the CSP allows.
- [`helpers.ts`](../apps/app/e2e/helpers.ts): `createAccount`, `verifyAndSignIn`, `createOrg`.

Visual (`apps/app/visual/`, ADR-0046): `pnpm test:visual`, always through `scripts/test-lock.sh visual` (like every dev server and test run here; it also takes port 3001 for the browser server).

- It starts the Playwright browser server from `mcr.microsoft.com/playwright:v<installed version>-noble` and runs Chromium, Firefox and WebKit against the local dev server at 320 and 1280 px, light and dark (the system theme, emulated with `page.emulateMedia({ colorScheme })` before the page loads). Not run in CI.
- Three modes ([`scripts/test-visual.mjs`](../scripts/test-visual.mjs)); every mode runs the checks: the strict CSP check below, the WebKit `<select>` canary and the keyboard pass.
  - no flag: the checks only. Takes no screenshot and never needs a baseline.
  - `--baseline`: the checks, and screenshots saved to the git-ignored `apps/app/visual/.baseline/` (replacing it), with the commit they were taken at in `.baseline/COMMIT` ("with uncommitted changes" when the tree was dirty).
  - `--compare`: the checks, and each screenshot compared with the baseline. It prints the baseline's commit, each changed screenshot and a summary line (`baseline <commit>, N compared, M changed`), and fails without a baseline (it never creates one).
  - Workflow: `--baseline` before UI work, `--compare` when done; the summary line goes in the PR's Checks. Baselines are local on purpose: if visual tests ever run in CI, committed baselines (reviewed in the PR) replace this.
- Names that change every run (the organization, its name field, the shared user) are masked, so a baseline and a compare of the same commit match (0 changed).
- [`keyboard.visual.ts`](../apps/app/visual/keyboard.visual.ts): on the settings page, in both themes, Tab reaches the page's controls in reading order and each stop shows a focus indicator (its outline, ring or border differs from its unfocused state); the transfer picker moves between options with the arrow keys and Escape closes it with focus kept (Chromium; arrow keys also Firefox; Playwright's WebKit can't drive its native popup, so that test skips in WebKit); the rename toast appears without taking focus. No page has a dialog or menu yet: their Escape and focus-return checks come with the first page that does.
- [`team.setup.ts`](../apps/app/visual/team.setup.ts): an organization with two more members (fixed accounts, so the transfer picker reads the same every run and has a choice for the arrow keys).
- The same strict CSP check as e2e, with two exclusions, both in WebKit visual tests only (owner-approved 2026-11-11). Chromium, Firefox and the e2e suite allow none:
  1. Playwright's screenshotter injects `<style>body {}</style>` in WebKit on each screenshot attempt: exactly one console message and one `style-src-elem` report from `:5`, removed only as a pair, and only while `snap` takes a screenshot.
  2. WebKit refuses its own stylesheet for a native `<select>` under `style-src 'self'`: exactly the two refusals in `WEBKIT_SELECT_REFUSALS` (`e2e/fixtures.ts`), once each per page that has a `<select>`. Any other or extra refusal fails. [`webkit-select.canary.visual.ts`](../apps/app/visual/webkit-select.canary.visual.ts) reproduces it on a bare page and fails when WebKit stops refusing; then delete the exclusion and the canary.

Contrast: [`scripts/brand-contrast.test.mjs`](../scripts/brand-contrast.test.mjs) (in `pnpm lint`) checks every token pair of `packages/brand/brand.css` in both themes (WCAG 1.4.3 and 1.4.11); `node scripts/brand-contrast.mjs` prints each ratio.

- [`mailbox.ts`](../apps/app/e2e/mailbox.ts): builds the verification link the email would carry, from the local `.dev.vars` secret.

## Tenant isolation

These must pass unchanged in every product: they're the tenancy guarantees.

- [`tenancy.test.ts`](../apps/app/test/tenancy.test.ts): `getTenantContext`, the cross-tenant matrix through services and server-function input (another tenant's resources are 404), repository scoping, input contracts (no `organizationId`).
- [`roles.test.ts`](../apps/app/test/roles.test.ts): the capability matrix, one case per role, and Better Auth's organization endpoints.
- [`database-isolation.test.ts`](../apps/app/test/database-isolation.test.ts): tests run against `app_test`, never the dev database.
- [`database-role.test.ts`](../apps/app/test/database-role.test.ts): `app_runtime`'s exact grants (`GRANTS`) and executable functions (`FUNCTIONS`); a new table fails until it's granted and listed.
- [`archive.test.ts`](../apps/app/test/archive.test.ts): every tenant table has its `archive_delete` trigger, and the runtime role can't reach the archive (ADR-0039).
- The E2E slice ([`e2e/slice.spec.ts`](../apps/app/e2e/slice.spec.ts)): cross-tenant isolation through real URLs (404 page, never data).

What new code adds (the AGENTS.md recipes are the authority): every tenant-owned table gets cross-tenant tests by URL **and** by server-function input, a `GRANTS` entry and its archive trigger; every tenant-scoped server function gets a case per role in `roles.test.ts` for its capability; a plan limit gets tests for the cap, upgrade, downgrade and concurrency.

## Testing a product feature

Copy the projects feature's tests ([`start-new-product.md`](runbooks/start-new-product.md) step 6 maps each layer): `tenancy.test.ts` for isolation, `roles.test.ts` for capabilities, `billing.test.ts` ("plan limits …") for a limit, `e2e/projects.spec.ts` for the browser path. Name tests for the behaviour they prove ("a non-member gets 404 on another tenant's overview", ADR-0030).

E2E sign-ins are budgeted: a local run signs in from one IP, and the login rate limit (5 sign-ins and 5 sign-ups a minute per IP, ADR-0005, no test exemption) caps them. A run uses 4 sign-ups and 5 sign-ins. A test that only needs a signed-in user starts from the shared session (`test.use({ storageState: sessionFile })`) and creates its own organization with `createOrg`, without relying on other tests' data. A new test that signs in for real spends budget.

## Database checks

`pnpm db:check` runs, against the migrations in `packages/db`:

1. **Applied migrations unchanged**: none edited, deleted or renamed, and the journal only grows, compared with a base: `$BASE` if set, else `origin/main`, else the merge base with `upstream/main` while every migration exists there (a product not pushed yet); otherwise it fails and asks for `BASE`. It's never skipped (header of `scripts/check-migrations.mjs`).
2. No colliding migrations, none missing (`drizzle-kit generate` writes nothing), and `packages/db/src/schema/auth.ts` matches the Better Auth config.
3. The migrations' SQL builds the schema plus the SQL-only objects registered in `packages/db/sql-only-objects.tsv`, applied by a non-superuser login mirroring `app_owner` (`scripts/check-schema-sql.sh`; needs Postgres). A new SQL-only object (function, trigger) makes it print the line to register; grants are checked by `database-role.test.ts` instead.

## CI vs local

CI (`.github/workflows/ci.yml`, job "Validate", with a Postgres 17 service) runs the bindings ADR check, the secret check, `pnpm check`, the parts of `pnpm db:check` (with the PR's parent as base), `pnpm test`, the backup script tests, `pnpm build` with the client-bundle secret scan, and `pnpm test:e2e` against a local dev server. A PR that only changes docs (`docs/**`, `apps/docs/**`, `apps/site/**`, `*.md`) runs only the bindings and secret checks and `pnpm check`. On other PRs, the `pnpm db:check` parts run only when the PR changes `packages/db/**`, `packages/auth/**`, the root `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml`, their scripts, `ci.yml`, `.github/actions/**` or `.node-version`, and the backup script tests only when it changes `scripts/backup/**`, `ci.yml`, `.github/actions/**` or `.node-version`; a push to `main` runs everything. The preview E2E above runs only for app PRs from this repository after CI succeeds: `preview.yml` skips docs-only and static-site-only PRs, forks, release-please and Dependabot PRs.

Locally, before handing a change over: `pnpm check`, `pnpm test` and `pnpm test:e2e` (AGENTS.md "Done means"), plus `pnpm db:check` when the schema or migrations change.

## Troubleshooting

- **`pnpm test` hits "Test timed out in 5000ms"** on a loaded or small machine (seen on 8 CPUs, 8 GB, WSL2), in different tests each run: run with fewer workers and a longer timeout, `pnpm --filter app test --maxWorkers=1 --testTimeout=30000`. The defaults stay as they are for CI.
- **`pnpm test:e2e` fails with "Too many requests"**: the run used up the login rate limit (ADR-0005). See [Testing a product feature](#testing-a-product-feature) for the sign-in budget.
