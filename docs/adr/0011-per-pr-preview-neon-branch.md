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
- **Fail closed:** `wrangler.jsonc` commits a `previews.hyperdrive` DB override with a sentinel id that doesn't exist. CI's injector replaces it with the PR's config (idempotent). Any preview deployed without injection fails (Cloudflare code 10157) instead of inheriting production. Added after Codex review.
- **CI credentials:** superseded by "CI credential tiers" below. The exposure is not accepted as a permanent risk (owner decision 2026-09-28).
- **Preview auth (VS001):** each preview deploy gets `BETTER_AUTH_URL` = its own deterministic URL (`--var`) and a random per-deploy `BETTER_AUTH_SECRET` (`--secrets-file`: a temp file with mode 600, deleted on exit, masked in logs). CI then runs the Playwright E2E against the preview. Sessions reset on each push, which is intended.

## CI credential tiers (owner decision 2026-09-28; proposed change, not yet implemented)

**Current exposure (found 2026-09-28):**

- The `preview` job gets `NEON_API_KEY` and `CLOUDFLARE_API_TOKEN` at job level, so every step can read them, including `pnpm install` (dependency lifecycle scripts), the PR's build, `drizzle-kit` with the PR's config, and Playwright.
- `NEON_API_KEY` is the same key the `db-backup` job uses on the **production** project.
- The Cloudflare token (Workers Scripts: Edit) can also deploy the **production** Worker.
- `pull_request` workflows run the PR's own copy of the workflow file, so any same-repo PR can read any repo-level secret. Conditions inside the workflow can't fence secrets off.
- `preview-cleanup.yml` on PR close checks out the PR's code and runs its `down.sh` with the same secrets.
- GitHub plan limits (GitHub Free, private repo, checked 2026-09-28):
  - no environments, no environment secrets, no deployment-branch rules, no branch protection (all need Pro or higher);
  - required reviewers need a public repo or Enterprise; Pro and Team don't offer them on private repos.

**Tiers:**

| Tier                      | Who / what                                                                                            | Credentials                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| T0 untrusted              | fork PRs, Dependabot PRs, and every step that executes PR code (install, build, tests, E2E)           | none                                                                                     |
| T1 trusted non-production | a same-repo PR (author has write access; today only the owner), in a job that executes **no PR code** | preview-only: a Neon key scoped to the preview project, and the Cloudflare preview token |
| T2 production             | `main` only, never an ordinary PR job                                                                 | production Neon key (backups), production deploy credentials                             |

**Proposed change (smallest that keeps today's PR validation):**

1. **Scoped Neon keys (owner creates; no plan change needed):**
   - `neon api-keys create --project-id withered-credit-11647832` → secret `NEON_PREVIEW_API_KEY` (preview project only: it can't read production or mint keys);
   - `--project-id flat-cherry-23373668` → the backup job's key.
   - Then stop using the org-wide `NEON_API_KEY` in CI.
2. **Split the preview job so secrets never meet PR code:**
   - `check` (T0) already builds. For same-repo PRs it also uploads an artifact: `apps/web/dist`, `apps/web/.wrangler/deploy/config.json`, `packages/db/drizzle`.
   - `preview-deploy` (T1):
     - checks out the PR's **base** commit (trusted scripts and lockfile), then `pnpm install --frozen-lockfile` without the Actions cache (a PR-populated cache could be poisoned);
     - downloads the artifact as data;
     - validates `dist/server/wrangler.json`: expected `name`, no `build` command, `no_bundle`, the `previews.hyperdrive` DB sentinel. It then points the sentinel at the PR's Hyperdrive config. This replaces injecting before the build: the build output carries the `previews` block, and patching it after the build is equivalent;
     - migrates the preview branch with the base commit's migrator, using the PR's SQL files as data;
     - runs `wrangler preview` (no bundling: `no_bundle: true`) and comments the URL.
     - Secrets are set only on the steps that need them.
   - `preview-e2e` (T0): the PR's Playwright suite against the preview URL, no secrets.
   - `preview-cleanup.yml`: `pull_request_target` (closed) plus the daily janitor, both running the default branch's code only.
3. **Production credentials stay out of GitHub until the plan allows fencing them:**
   - The first deploy is manual from the owner's machine (runbook "First production deploy").
   - The backup key is the one production credential in CI today. It stays reachable by a workflow-editing same-repo PR until either:
     - **(a)** GitHub Pro: an environment `production` limited to deployment branch `main` holds it (and later a deploy token); or
     - **(b)** backups run outside GitHub Actions.
   - Owner decision.
4. **Rollout in two PRs.** The deploy job runs the base branch's scripts, so first merge the new scripts (tested by hand against the preview project), then switch the workflow.

**Residual risks after the change:**

- A same-repo PR that edits a workflow can still read repo-level T1 secrets. Accepted only while write access is limited to the owner. Before anyone else gets write access, T1 secrets must move to an environment (Pro), or previews move to a separate account.
- The Cloudflare preview token can also deploy the production Worker. API tokens can't be limited to one Worker script [to confirm]. Full separation means previews run in a separate Cloudflare account (owner decision; later).
