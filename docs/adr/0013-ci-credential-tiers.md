# ADR-0013: CI credential tiers: no secrets where PR code runs

Status: Accepted (owner decisions 2026-09-28; rollout in progress, see "Rollout status") · Date: 2026-09-28

Superseded in part by [ADR-0019](0019-ci-credentials-and-preview-slots.md): the T1 Cloudflare token scope, the production Neon key's name/location, and the rollout list.

Supersedes the CI credentials "accepted risk" in [ADR-0011](0011-per-pr-preview-neon-branch.md). Until the rollout completes, parts of the exposure below stay live.

## Context

The owner rejected the ADR-0011 exposure as a permanent risk. Facts, checked 2026-09-28:

- **Preview job:** it gets `NEON_API_KEY` and `CLOUDFLARE_API_TOKEN` at job level, so every step can read them. That includes `pnpm install` (dependency lifecycle scripts), the PR's build, `drizzle-kit` with the PR's config, and Playwright.
- **Neon key:** `NEON_API_KEY` is the same key the `db-backup` job uses on the **production** project.
- **Cloudflare token:** it has Workers Scripts: Edit, and previews are versions of the production Worker `saas-foundation`, so the token can also deploy **production**.
- **Workflow files:** `pull_request` workflows run the PR's own copy of the workflow file. Any same-repo PR can read any repo-level secret; conditions inside the workflow can't fence secrets off.
- **Cleanup:** `preview-cleanup.yml` on PR close checks out the PR's code and runs its `down.sh` with the same secrets.
- **GitHub plan (verified empirically 2026-09-28 with a throwaway environment and branch):**
  - environment secrets and vars **are** readable by jobs in this private repo;
  - deployment-branch rules **are** enforced: a job on a non-`main` branch using a `main`-only environment was refused before it started;
  - required reviewers are still unavailable. (GitHub's docs say Free private repos lack environments; the repo's actual behaviour wins.)
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
   - **The owner creates it once:** a per-Worker token can't create a Worker.
   - The owner then **rotates** (revokes) the current `CLOUDFLARE_API_TOKEN`, which can deploy production.
   - Its token is an account-owned token scoped to that Worker, plus the Hyperdrive permissions previews need.
   - The production Worker is then out of the preview token's reach.
   - The trusted deploy job targets that Worker itself: `wrangler preview --config dist/server/wrangler.json --worker-name saas-foundation-preview` (both flags exist in the pinned Wrangler 4.142.0). It never relies on the artifact's `name`.
   - Preview URLs, `BETTER_AUTH_URL`, the URL-shape guard, `down.sh` and the janitor switch to the preview Worker's name.
3. **Split the preview job so secrets never meet PR code:**
   - **`check` (T0):** already builds. For same-repo PRs it also uploads an artifact: `apps/web/dist` and `packages/db/drizzle`.
   - **`preview-deploy` (T1):**
     - checks out the PR's **base** commit (trusted scripts and lockfile);
     - runs `pnpm install --frozen-lockfile` **without** the Actions cache (a PR-populated cache could be poisoned);
     - downloads the artifact as data;
     - does **not** import the build's `.wrangler/deploy/config.json` redirect, which could point Wrangler at another config. It passes the artifact's `dist/server/wrangler.json` explicitly (`--config`) and validates it first:
       - `name` equal to `saas-foundation` (the name in the committed config; the deploy target is overridden as above);
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
   - Today CI holds two production-capable credentials: the backup Neon key, and the preview Cloudflare token (until step 2 rotates it and scopes it to `saas-foundation-preview`). After step 2, the backup key is the only one. It stays reachable by a same-repo PR that edits a workflow until either:
     - **(a)** an environment limited to deployment branch `main` holds it; or
     - **(b)** backups run outside GitHub Actions.
   - **Owner decision (2026-09-28): (a).** No separate backup Worker. Environment `production` (deployment branch `main` only) holds `NEON_BACKUP_API_KEY`, the Neon key scoped to the production project. `db-backup.yml` runs in that environment. A PR can reference the environment but GitHub refuses the job, because its ref isn't `main`.
   - The T1 preview key stays a repo-level secret. Moving it into the unprotected `preview` environment would add nothing, since any PR can name that environment.
5. **Rollout in two PRs.** The deploy job runs the base branch's scripts, so first merge the new scripts (tested by hand against the preview project), then switch the workflow.

## Consequences

- PR validation is unchanged: check, test, build, preview deploy, E2E against the preview.
- Residual risks:
  - A same-repo PR that edits a workflow can still read repo-level T1 secrets. This is accepted only while write access is limited to the owner. Before anyone else gets write access, T1 secrets move to an environment (Pro), or the repo's trust model is revisited.
  - Environment branch rules are the only fence around T2. They're repo settings, so anyone with admin access can change them. Today that's only the owner.
- The preview project's Neon branch limit (9 concurrent previews) and the Hyperdrive config limit are unchanged.

## Rollout status (2026-09-28)

- [x] Neon project-scoped keys created by the owner; `NEON_PREVIEW_API_KEY` set as a repo secret.
- [x] Environment `production` created, deployment branch `main` only.
- [x] CI previews and cleanup use `NEON_PREVIEW_API_KEY`, set only on the script steps (not install or E2E). `db-backup.yml` runs in `production` and fails fast if `NEON_BACKUP_API_KEY` is missing.
- [ ] Owner: set `NEON_BACKUP_API_KEY` in the `production` environment. Done only once a dispatched backup run has succeeded with it (`gh workflow run db-backup.yml`).
- [x] Previews run on the separate Worker `saas-foundation-preview` (`--worker-name`). Only the CI build copy enables `preview_urls`; the committed production config keeps them off. The preview scripts refuse to run if `CLOUDFLARE_ACCOUNT_ID` differs from the pinned `account_id`.
- [x] `CLOUDFLARE_API_TOKEN` replaced by the owner with a token for the new account (ADR-0017).
- [ ] Owner: delete the repo-level `NEON_API_KEY`, then revoke the org-wide Neon key, once previews and a backup run are green without it.
- [ ] Per-Worker token for `saas-foundation-preview` plus Hyperdrive, replacing the account-wide `CLOUDFLARE_API_TOKEN` (step 2). Until then, same-repo PR code runs next to a token that can deploy production (residual, owner-only write access).
- [ ] Split preview job: PR 1 scripts, PR 2 workflow (steps 3 and 5).
