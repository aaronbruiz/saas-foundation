# ADR-0013: CI credential tiers: no secrets where PR code runs

Status: Proposed (owner decision 2026-09-28 to tighten; implementation pending owner actions) · Date: 2026-09-28

Supersedes the CI credentials "accepted risk" in [ADR-0011](0011-per-pr-preview-neon-branch.md).

## Context

The owner rejected the ADR-0011 exposure as a permanent risk. Facts, checked 2026-09-28:

- **Preview job:** it gets `NEON_API_KEY` and `CLOUDFLARE_API_TOKEN` at job level, so every step can read them. That includes `pnpm install` (dependency lifecycle scripts), the PR's build, `drizzle-kit` with the PR's config, and Playwright.
- **Neon key:** `NEON_API_KEY` is the same key the `db-backup` job uses on the **production** project.
- **Cloudflare token:** it has Workers Scripts: Edit, and previews are versions of the production Worker `saas-foundation`, so the token can also deploy **production**.
- **Workflow files:** `pull_request` workflows run the PR's own copy of the workflow file. Any same-repo PR can read any repo-level secret; conditions inside the workflow can't fence secrets off.
- **Cleanup:** `preview-cleanup.yml` on PR close checks out the PR's code and runs its `down.sh` with the same secrets.
- **GitHub plan:** GitHub Free, private repo. Environment secrets and deployment-branch rules need Pro or higher. Required reviewers need a public repo or Enterprise; Pro and Team don't offer them on private repos. Branch protection needs Pro.
- **Available scoping:**
  - Neon supports **project-scoped API keys**: a key limited to one project can't read other projects or mint keys.
  - Cloudflare account-owned API tokens can be scoped to **specified Workers** (changelog 2026-09-15). The scope of Hyperdrive permissions is [to confirm].

## Decision

| Tier                      | Who / what                                                                                                  | Credentials                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| T0 untrusted              | fork PRs, Dependabot PRs, and every step that executes PR code (install, build, tests, E2E)                 | none                                                                                                                          |
| T1 trusted non-production | a same-repo PR (author has write access; today only the owner), in a job that executes **no PR code**       | preview-only: a Neon key scoped to the preview project, and a Cloudflare token scoped to the preview Worker (plus Hyperdrive) |
| T2 production             | intended boundary: `main` only, never an ordinary PR job (see "Production credentials" for the current gap) | production Neon key (backups), production deploy credentials                                                                  |

**Change (smallest that keeps today's PR validation):**

1. **Scoped Neon keys** (owner creates them):
   - `neonctl api-keys create --project-id withered-credit-11647832` → secret `NEON_PREVIEW_API_KEY`;
   - `--project-id flat-cherry-23373668` → the backup job's key.
   - CI then stops using the org-wide `NEON_API_KEY`.
2. **Separate preview Worker:**
   - Previews move from versions of `saas-foundation` to a Worker named `saas-foundation-preview`.
   - Its token is an account-owned token scoped to that Worker, plus the Hyperdrive permissions previews need.
   - The production Worker is then out of the preview token's reach.
3. **Split the preview job so secrets never meet PR code:**
   - **`check` (T0):** already builds. For same-repo PRs it also uploads an artifact: `apps/web/dist` and `packages/db/drizzle`.
   - **`preview-deploy` (T1):**
     - checks out the PR's **base** commit (trusted scripts and lockfile);
     - runs `pnpm install --frozen-lockfile` **without** the Actions cache (a PR-populated cache could be poisoned);
     - downloads the artifact as data;
     - does **not** import the build's `.wrangler/deploy/config.json` redirect, which could point Wrangler at another config. It passes the artifact's `dist/server/wrangler.json` explicitly (`--config`) and validates it first:
       - the expected Worker `name`;
       - no `build` command;
       - `no_bundle: true`;
       - the `previews.hyperdrive` DB sentinel;
       - no binding outside an allowlist.
     - points the sentinel at the PR's Hyperdrive config. Patching after the build is equivalent to injecting before it: the build output carries the `previews` block.
     - migrates the preview branch with the base commit's migrator, taking the PR's SQL files as data.
     - runs `wrangler preview` and comments the URL.
     - Secrets are set only on the steps that need them.
   - **`preview-e2e` (T0):** the PR's Playwright suite against the preview URL, no secrets.
   - **`preview-cleanup.yml`:** `pull_request_target` (closed) and the daily janitor, both running only default-branch code.
4. **Production credentials:**
   - Deploy credentials never go to GitHub on the current plan. The first deploy is manual from the owner's machine (runbook "First production deploy").
   - The backup key is today's only production credential in CI. It stays reachable by a same-repo PR that edits a workflow until either:
     - **(a)** GitHub Pro: an environment limited to deployment branch `main` holds it; or
     - **(b)** backups run outside GitHub Actions.
   - Owner decision.
5. **Rollout in two PRs.** The deploy job runs the base branch's scripts, so first merge the new scripts (tested by hand against the preview project), then switch the workflow.

## Consequences

- PR validation is unchanged: check, test, build, preview deploy, E2E against the preview.
- Residual risks:
  - A same-repo PR that edits a workflow can still read repo-level T1 secrets. This is accepted only while write access is limited to the owner. Before anyone else gets write access, T1 secrets move to an environment (Pro), or the repo's trust model is revisited.
  - Until (a) or (b), the same applies to the backup key.
- The preview project's Neon branch limit (9 concurrent previews) and the Hyperdrive config limit are unchanged.
