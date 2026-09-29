# ADR-0021: Per-PR preview data behind a trusted workflow boundary

Status: Accepted (2026-09-29; rollout below) · Date: 2026-09-29

Supersedes in part:

- [ADR-0019](0019-ci-credentials-and-preview-slots.md): decision 4 (preview slots) and the claim in decision 3 that the preview credentials can't touch production Hyperdrive;
- [ADR-0013](0013-ci-credential-tiers.md): completes step 3 (the workflow split), with privileged jobs on `workflow_run` / `pull_request_target` and secrets in `main`-only environments.

Restores [ADR-0011](0011-per-pr-preview-neon-branch.md)'s per-PR branch and Hyperdrive config, now created and deleted only by trusted jobs.

## Context

Investigated 2026-09-28/29 on the preview Worker, with evidence (test PR numbers 9005–9014).

**Deleted Worker Previews keep executing with their bindings** (Cloudflare Previews open beta; a bug report is drafted).

- After `wrangler preview delete`, the control plane no longer knows the Preview (`GET …/previews/<name>` → `10025`, the listing is empty, re-deleting says "not found"; Worker versions and deployments lists are empty). Yet:
  - its Preview URL and its Unique Deployment URLs (`<8hex>-saas-foundation-preview…`) kept answering, 10/10 requests, 25 minutes to more than a day later;
  - a request through a deleted Preview URL **wrote a row into its slot's database** (`rate_limit`), so this is the old code running with a live Hyperdrive binding, not a cached response;
  - a disposable Preview's URL flapped between 404 and its old response for minutes after deletion, so a single 404 proves nothing either.
- A name or deployment id that never existed answers a generic 404 (`x-preview-user-error: true`), so answers from deleted names are real executions.
- Consequence for ADR-0019: a reused slot stays reachable, indefinitely, by every earlier PR's code through predictable public URLs. Quarantine never ends, so slots run out.

**Deploying a Worker needs no permission on the resources it binds.** Cloudflare: "To deploy a Worker that has bindings … you need `Editor` access to the Worker. You do not need separate permissions on the bound resources." The per-Worker token can therefore deploy a preview bound to _any_ Hyperdrive id in the account, including `saas-foundation-prod`, whose id is public in `wrangler.jsonc`. It is effectively a production-data credential, contrary to ADR-0019 decision 3.

**Hyperdrive tokens are account-wide.** Create and delete accept only `Hyperdrive Write` ("Hyperdrive Edit" in the permissions reference); get/list accept Read or Write. There is no per-config scope.

**`pull_request` workflows run the PR's own YAML.** A same-repo PR can edit `ci.yml` and read any repo-level secret. Checking out the base commit protects the scripts, not the workflow. Environment secrets whose deployment branch policy is `main` only are not given to jobs whose ref is `refs/pull/N/merge` (verified that environment secrets work on this repo: `db-backup.yml` read `NEON_API_KEY` from `production` on 2026-09-29).

**The per-PR model neutralises zombies** (local acceptance test, 2026-09-29, PRs A=9011/B=9012 and 9013/9014 with the real scripts):

1. A and B got different Hyperdrive ids, branches, endpoints and role passwords.
2. A sign-in through A wrote only to A's database; through B only to B's.
3. A closed: Preview deleted, then its Hyperdrive config, then its branch.
4. A's Unique Deployment URL still executed: 10/10 `503 {"ok":false,"db":"down"}`.
5. Control plane: Preview `10025`, Hyperdrive `GET` → 404, branch gone.
6. Requests through A's zombie reached no database (health down; sign-in 500).
7. B's data was byte-identical before and after the zombie requests; B stayed healthy.
8. Re-opening A created a **new** Hyperdrive id; the zombie, bound to the deleted id, stayed down.

## Decision

**1. Per PR: Neon branch `preview/pr-N` and Hyperdrive config `saas-pr-N`, never reused between PRs.** Deleting the PR's Hyperdrive config is the database revocation boundary. An HTTP 404 from a stale Preview URL is not a signal of anything. A reopened PR gets a new config id; old deployments stay bound to the deleted one. The branch gets its own `app_owner` password when it is created, so no other branch's password works on it. On every deploy the branch data is reset to `preview-seed` (roles, password and endpoint are kept, so the config stays valid).

**2. Workflows** (no job runs PR code; no privileged job restores or saves a cache):

| Workflow / job                        | Trigger (definition)                                           | Environment and credentials                                                                  | Artifact                              |
| ------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------- |
| `ci.yml` check                        | `pull_request` (the PR's YAML)                                 | none                                                                                         | builds it, uploads it (same-repo PRs) |
| `preview.yml` resolve                 | `workflow_run` of CI (default branch)                          | none                                                                                         | —                                     |
| `preview.yml` infra                   | same                                                           | `preview-infra`: `CLOUDFLARE_PREVIEW_INFRA_TOKEN` (Hyperdrive Write), `NEON_PREVIEW_API_KEY` | **never**                             |
| `preview.yml` deploy                  | same                                                           | `preview`: `CLOUDFLARE_API_TOKEN` (per-Worker Editor), `NEON_PREVIEW_API_KEY`                | downloaded as data                    |
| `preview.yml` e2e                     | same                                                           | none (comments the URL)                                                                      | —                                     |
| `preview-cleanup.yml` cleanup-preview | `pull_request_target: closed`, daily schedule (default branch) | `preview`: `CLOUDFLARE_API_TOKEN`                                                            | —                                     |
| `preview-cleanup.yml` cleanup-infra   | same, after cleanup-preview (runs even if it failed)           | `preview-infra`: `CLOUDFLARE_PREVIEW_INFRA_TOKEN`, `NEON_PREVIEW_API_KEY`                    | —                                     |

- `resolve` takes the PR number from GitHub (the one open same-repo PR whose head is exactly the run's commit; older commits' runs are skipped), never from the branch name or the artifact.
- **No job holds both the Worker token and the Hyperdrive token.** The job holding the Hyperdrive token never receives the artifact; the job receiving the artifact never holds the Hyperdrive token. The deploy job keeps the preview Neon key for migrations (job outputs can't carry secrets, and the SQL must not reach the infra job); that key reaches preview data only.
- `infra` and both cleanup jobs install no packages: `curl`, `jq` and `gh` against the Cloudflare and Neon REST APIs. `deploy` and `e2e` install the default branch's lockfile with caching explicitly off (`pnpm/action-setup` `cache: false`, `actions/setup-node` `package-manager-cache: false`); `e2e` runs the default branch's Playwright suite (the PR's own tests ran in CI).
- Both environments allow deployments from `main` only. The preview secrets live only there, never at repo level.
- Deploy and both cleanup jobs of one PR share the concurrency group `preview-pr-N`. Deploy refuses a PR that isn't open; cleanup acts only on a PR that is closed right now.

**3. Guards** (all in default-branch code, `scripts/preview/`):

- Names come only from the validated numeric PR number (`^[1-9][0-9]{0,6}$`): `pr-N`, `preview/pr-N`, `saas-pr-N`.
- Before using or deleting a Hyperdrive config, `infra.sh` refuses unless its name is exactly `saas-pr-N` and its id isn't the production id pinned in `wrangler.jsonc`. To **use** it, its origin must be exactly this PR's branch endpoint in the preview project; to **delete** it, its origin must not be the production origin (a config whose branch is already gone no longer points at a preview endpoint). CI never updates a config: it creates, reuses (guard passed) or deletes. A leftover config of the same name that fails the use guard is deleted and replaced.
- The deploy script and `prepare-config.mjs` refuse the production id as a binding target. The artifact's config must carry the fail-closed sentinel, and only the job-created id is patched in (ADR-0013 step 3 validator).
- The artifact is refused if it contains symlinks, `.dev.vars*` or `.env*` files. It is read only as JSON, static files and migration SQL (run by the default-branch migrator against the PR's own branch). CI uploads it without hidden files.
- The account id must match the one pinned in `wrangler.jsonc`.

**4. Kept from ADR-0019:** the per-Worker token (now in the `preview` environment), `CLOUDFLARE_WORKERS_SUBDOMAIN`, the production Neon key in `production`. Slots, `provision-slots.sh`, `PREVIEW_HYPERDRIVE_SLOTS`, quarantine and URL verification are removed.

**Optional, not part of the boundary:** deleting and recreating the preview Worker may flush zombie deployments. Not tested and not automated; CI gets no Workers Admin permission for it.

## Consequences

- Neon Free's 10 branches per preview project bound concurrent previews (the seed uses one). A closed PR frees its branch immediately.
- Hyperdrive allows 25 configs per account; production uses one.
- Zombie deployments of closed PRs stay publicly reachable, running old code without a database, until Cloudflare fixes the bug. They can still serve static assets and error pages under our workers.dev subdomain.
- `workflow_run` jobs report on the default branch, not as PR checks; the PR comment carries the preview URL and E2E result.
- The first real run of `preview.yml` can only happen after this ADR's PR is on `main` (GitHub runs `workflow_run` workflows from the default branch).
- Two Cloudflare tokens, both sensitive: the Hyperdrive token can rewrite production Hyperdrive; the Worker token can bind it. Both live only in `main`-only environments and are used only by default-branch code. Anyone who can push to `main` controls CI; on this plan there is no branch protection, so that is the owner alone.

## Rollout

- [x] Local acceptance tests (above) with the admin session, including the guard negatives (production id, name mismatch, a slot config, a non-numeric PR number, `.dev.vars`, `.env.local`).
- [x] Environments `preview-infra` and `preview` restricted to deployment branch `main`.
- [ ] Owner: create `CLOUDFLARE_PREVIEW_INFRA_TOKEN` (account-owned, Account · Hyperdrive · Edit/Write only) and a preview-project Neon key; set `CLOUDFLARE_PREVIEW_INFRA_TOKEN` and `NEON_PREVIEW_API_KEY` in `preview-infra`, and `CLOUDFLARE_API_TOKEN` (per-Worker) and `NEON_PREVIEW_API_KEY` in `preview`.
- [ ] Merge; validate with a real PR through `workflow_run` (deploy, E2E, close → Preview deleted, config and branch deleted).
- [ ] Then: delete the repo-level `CLOUDFLARE_API_TOKEN` and `NEON_PREVIEW_API_KEY`, revoke the old preview Neon key, delete the six `saas-preview-slot-*` configs and `preview/slot-*` branches (which also revokes the 9005/9010 zombies) and the variable `PREVIEW_HYPERDRIVE_SLOTS`.
