# Your first successful change

A walkthrough from a fresh checkout to a small, tested change ready for review. It runs entirely on your machine: no Cloudflare, Neon or Polar account and no provider credential. Provisioning a product's own infrastructure is a different task ([`start-new-product.md`](../runbooks/start-new-product.md) steps 2–4).

The change is an exercise: add an optional **reference** to the sample project (an external code such as `OPS-42`). It follows the same path as the project's existing `description` field, through every layer a tenant-owned feature touches. Don't merge the exercise; when you build a real feature, the same steps apply to your own resource ([`start-new-product.md`](../runbooks/start-new-product.md#6-build-the-first-feature) step 6).

**Tutorial-only assumptions** (they aren't product rules): the reference is nullable plain text, at most 64 characters, not unique, not a URL and not linked to anything. It uses the project's existing capabilities (`project:create`, `project:update`, `project:read`) and tenant boundaries. A real feature that needs a new capability, limit or visibility rule settles it with the owner first ([`AGENTS.md`](../../AGENTS.md#working-rules) "Working rules").

## 1. Check the toolchain

| Tool    | Version from                                                        | Check                                    |
| ------- | ------------------------------------------------------------------- | ---------------------------------------- |
| Node    | [`.node-version`](../../.node-version), `engines` in `package.json` | `node --version` prints that major       |
| pnpm    | `packageManager` in [`package.json`](../../package.json)            | `corepack enable`, then `pnpm --version` |
| Docker  | any current Docker with Compose                                     | `docker compose version`                 |
| Browser | Playwright's Chromium, for E2E                                      | step 3                                   |

Missing one: install it before going on. Nothing below works around a missing tool.

## 2. Install and configure

```sh
pnpm install --frozen-lockfile
cp apps/app/.dev.vars.example apps/app/.dev.vars
```

Edit `apps/app/.dev.vars` and replace `BETTER_AUTH_SECRET` with a fresh value (`openssl rand -base64 32`). Keep everything else: the example is already local-only (open sign-up, emails printed to the console, Cloudflare's always-pass Turnstile test keys, billing off). Don't add Polar or other provider values for this walkthrough, and never put real secrets in the file or in a chat. `.dev.vars` is git-ignored (AGENTS.md invariant 8).

**Success:** `pnpm install` ends with "Done"; `git status` doesn't list `.dev.vars`.

## 3. Start the database and the app

```sh
pnpm db:up        # local Postgres 17 on 127.0.0.1:5432: dev database `app`, test database `app_test`
pnpm db:migrate   # applies packages/db/drizzle to `app`
pnpm --filter app exec playwright install --with-deps chromium   # once per machine, for E2E
pnpm dev          # http://localhost:3000
```

**Success:** `db:up` reports the container healthy; `db:migrate` prints `[migrate] applied N journal entries`; `http://localhost:3000/api/health` answers; `/signup` shows the form with the Turnstile widget. Sign up with any address: the verification link is printed in the `pnpm dev` terminal (`EMAIL_DELIVERY=console`). Open it, sign in, and create an organization. You land on its projects page, `/t/<slug>/projects`.

**If it fails:**

- `pnpm dev` says port 3000 is in use: stop. The port is fixed because the auth origins depend on it. Don't switch ports and don't kill another process yourself; free it with `kill -9 $(lsof -t -i:3000)` once you know it's yours to stop ([`AGENTS.md`](../../AGENTS.md#commands) "Port 3000 busy"). An agent stops here and asks the user.
- Another checkout on this machine already runs `pnpm db:up`: every checkout shares the same container and databases (`docker-compose.yml`), so run `db:up` from one of them only. A worktree's own `db:up` can start a separate, empty database.
- More symptoms: [Troubleshooting](../troubleshooting/README.md#local-setup-fails-or-port-3000-is-in-use).

Stop `pnpm dev` (Ctrl-C) before running the checks: E2E starts its own server on the same port.

## 4. Run the checks once before changing anything

```sh
pnpm check                    # lint, format, typecheck, plans and CSP hash drift
scripts/test-lock.sh test     # Worker tests against app_test
scripts/test-lock.sh e2e      # Playwright against a dev server on port 3000
```

Always run tests through `scripts/test-lock.sh`: every checkout on the machine shares `app_test`, the dev database and port 3000, and the lock serializes them ([`docs/testing.md`](../testing.md)). Each run prints where its full log is.

**Success:** all three exit 0. Expected noise: `[vpw:warn] Failed to statically analyze the exports of the main Worker entry-point`. A failure here, before you've changed anything, is about the environment, not your change: [Troubleshooting](../troubleshooting/README.md#tests-fail-only-when-run-as-a-suite).

## 5. Write the spec first

Create a branch named `<type>/<scope>-<description>` ([ADR-0030](../adr/0030-git-workflow.md)), for example `feat/projects-reference`. The PR description is the spec: write Goal, Behaviour (with the failure cases), Out of scope and Checks before the code ([`.github/pull_request_template.md`](../../.github/pull_request_template.md); the `feature-spec` skill drafts one). For this exercise, Behaviour could read:

- A member creates a project with an optional reference of at most 64 characters and sees it on the project's page; a longer one is refused with 400 and nothing changes.
- A member changes or clears the reference from the project's page.
- Another tenant's project, by URL or by server-function input, is a 404 and its reference is unchanged.

Every role already has `project:create` and `project:update` ([`server/permissions.ts`](../../apps/app/src/server/permissions.ts)), so there's no insufficient-role case. A feature that adds a capability needs one, tested per role in `roles.test.ts`.

## 6. Make the change, layer by layer

Follow `description` through each file; the reference goes next to it. The layers and their rules are the projects pattern ([`start-new-product.md`](../runbooks/start-new-product.md#6-build-the-first-feature) step 6) and the [recipes](../architecture/recipes.md).

| Layer           | File                                                                                                                                                                           | Change                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table           | [`packages/db/src/schema/projects.ts`](../../packages/db/src/schema/projects.ts)                                                                                               | `reference: text('reference'),` after `description` (nullable: no `.notNull()`)                                                                                         |
| Migration       | `packages/db/drizzle/`                                                                                                                                                         | `pnpm db:generate`, then read the new SQL: one `ALTER TABLE "project" ADD COLUMN "reference" text;`. Adding a nullable column is forward-safe (AGENTS.md invariant 10). |
| Repository type | [`packages/db/src/tenancy.ts`](../../packages/db/src/tenancy.ts) (`ProjectFields`)                                                                                             | `reference?: string \| null`. The repository functions already scope every statement to `ctx.orgId` in `inTenant`; nothing else changes there.                          |
| Contract        | [`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts) (`ProjectFields`)                                                                                   | `reference: z.string().trim().max(64).optional(),`. The object stays strict, so `organizationId` is still refused (invariant 9).                                        |
| Service         | [`modules/projects/service.ts`](../../apps/app/src/modules/projects/service.ts)                                                                                                | Nothing: it passes the parsed fields to the repository after `getTenantContext` and `authorize`.                                                                        |
| Pages           | [`t.$tenant.projects.index.tsx`](../../apps/app/src/routes/t.$tenant.projects.index.tsx), [`t.$tenant.projects.$id.tsx`](../../apps/app/src/routes/t.$tenant.projects.$id.tsx) | A `Field` with `FieldLabel` "Reference" and an `Input` with `maxLength={64}` after the description, read from the form like `description`.                              |

What doesn't need a step here, and why: the table's `app_runtime` grants are per table, so a new column needs no grant migration; the `archive_delete` trigger copies whole rows, so it needs no change; the column doesn't point at a user, so no `refuse_deleted_user` trigger. A new table needs all three ([recipes](../architecture/recipes.md) "Add a tenant-owned table").

Pages import contract types only and never a schema (ADR-0046 decision 7); the server's 400 is what refuses a long reference, and `maxLength` only helps the person typing.

## 7. Add the tests

Name each test for the behaviour it proves ([ADR-0030](../adr/0030-git-workflow.md)).

- [`apps/app/test/tenancy.test.ts`](../../apps/app/test/tenancy.test.ts), next to "gets, updates and deletes within the tenant": a project created with a reference returns it; 64 characters are accepted; 65 are refused with 400 (`expectStatus`).
- The same file's "cross-tenant matrix": a case per route in the loop (`foreign slug`, `own slug + foreign id`) that updating A's project's reference as Bob is a 404. This is the cross-tenant test for the new field: by URL (the foreign slug) and by input (an own slug with a foreign id).
- [`apps/app/e2e/projects.spec.ts`](../../apps/app/e2e/projects.spec.ts): a reference set at creation shows on the project's page and survives a change and a reload. Start from the shared session (`test.use({ storageState: sessionFile })`) and create the test's own organization with `createOrg`, so it spends none of the sign-in budget ([`docs/testing.md`](../testing.md#testing-a-product-feature)).

`roles.test.ts` already proves `project:update` for each role. `database-role.test.ts` and `archive.test.ts` pass unchanged, which confirms that no grant or trigger was needed.

## 8. Verify

```sh
pnpm format                   # apply Oxfmt
pnpm check
pnpm db:check                 # the migration is new and the schema changed
pnpm db:migrate               # E2E refuses to start while the dev database has pending migrations
scripts/test-lock.sh test
scripts/test-lock.sh e2e
```

**Success:** every command exits 0, and `db:check` ends without a line to register (a new column is no SQL-only object). Then look at it yourself: `pnpm dev`, open a project, set a reference, save, reload. A UI change of your own also gets the visual and keyboard checks of the `ui-page` skill ([`.agents/skills/ui-page/SKILL.md`](../../.agents/skills/ui-page/SKILL.md)).

## 9. Prepare the pull request

- Fill in Checks: each command, its result and the head and base commits it ran on; how each Behaviour line is verified; what wasn't run and why ([`AGENTS.md`](../../AGENTS.md#working-rules) "Working rules").
- Commit with a Conventional title: `feat(projects): optional reference`. The PR title becomes the squash commit on `main` ([ADR-0030](../adr/0030-git-workflow.md)).
- Review comes before the push. In this repository Claude implements and Codex reviews in a separate tree ([ADR-0012](../adr/0012-claude-implements-codex-reviews.md), the `review-pr` skill); apply the findings, then push once and open the PR (`CLAUDE.md`). The owner merges.

This exercise ends here: delete its branch, or keep it only as a local reference. Don't open it as a PR.

## What you've used

The tenant boundary (`getTenantContext`: slug → membership → 404), capabilities (`authorize`: 403 for an insufficient role), repositories in `inTenant`, strict contracts without `organizationId`, a forward-safe migration, cross-tenant tests by URL and input, the test lock, and the spec-first PR. Each is explained in the [domain model](../architecture/domain-model.md) and the [design system](../design-system/README.md) covers the page side.
