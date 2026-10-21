# ADR-0021: Per-PR preview data behind a trusted workflow boundary

Status: Accepted (2026-09-29; rollout complete 2026-09-29) · Date: 2026-09-29

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
- `infra` and both cleanup jobs install no packages: `curl`, `jq` and `gh` against the Cloudflare and Neon REST APIs. `deploy` and `e2e` install the default branch's lockfile with caching explicitly off (`.github/actions/setup` with no `cache` input: `pnpm/action-setup` `cache: false`, `actions/setup-node` `package-manager-cache: false`); `e2e` runs the default branch's Playwright suite (the PR's own tests ran in CI).
- Both environments allow deployments from `main` only. The preview secrets live only there, never at repo level.
- A preview run and the close-triggered cleanup of one PR share the workflow-level concurrency group `preview-pr-N` (no in-progress cancellation; `queue: max` keeps up to 100 pending runs; #31), so cleanup waits for a running preview, E2E included. The daily janitor can't take per-PR locks, so it skips a PR whose preview run hasn't completed (a GitHub API error or an incomplete result counts as active). Deploy refuses a PR that isn't open; cleanup acts only on a PR that is closed right now.

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
- [x] Owner (2026-09-29): `CLOUDFLARE_PREVIEW_INFRA_TOKEN` (account-owned, Account · Hyperdrive · Edit/Write only) set in `preview-infra`; the per-Worker `CLOUDFLARE_API_TOKEN` set in `preview`; `NEON_PREVIEW_API_KEY` set in both.
- [x] Merged (#26); validated with a real PR through `workflow_run` (#27, closed unmerged):
  - `preview.yml`: resolve, infra, deploy and e2e green. Both tokens verified as active account-owned tokens; `preview/pr-27` and `saas-pr-27` created; migrations applied; health OK; the default-branch E2E suite passed (2/2); the URL comment posted. The deployment's only Hyperdrive binding was `saas-pr-27`'s id.
  - Close → `preview-cleanup.yml`: cleanup-preview then cleanup-infra green: Preview deleted, then the config, then the branch. Checked independently: Preview `10025`, config `GET` → 404, branch gone; the deployment URL still executed, answering 10/10 `503 {"ok":false,"db":"down"}`.
- [x] Repo-level `CLOUDFLARE_API_TOKEN` and `NEON_PREVIEW_API_KEY` deleted: the repository holds no secrets; every CI secret is in a `main`-only environment.
- [x] The six `saas-preview-slot-*` Hyperdrive configs, the six `preview/slot-*` branches (two of them quarantined) and the variable `PREVIEW_HYPERDRIVE_SLOTS` deleted. The preview project now holds only `preview-seed`; the account's only Hyperdrive config is `saas-foundation-prod`. The zombie deployments of the slot tests (pr-9005, pr-9010 and their deployment URLs) now answer `503 db:down`: deleting their slot configs revoked them.
- [x] Preview Neon key rotated: the new project-scoped key **`saas-foundation-preview-ci`** (preview project) is in both environments; a second real PR (#28, closed unmerged) ran the full lifecycle with it (deploy, migrations, E2E, cleanup; config and branch gone afterwards; zombie `db:down`). The old key `saas-foundation-preview` was then revoked.
- [x] Correction to ADR-0019's rollout: the production-scoped Neon key `saas-foundation` is **not** unused. It is the key stored as `NEON_API_KEY` in `production` and is used by `db-backup.yml`; keep it. The personal key is no longer in the organization.
- Deferred, optional: deleting and recreating the preview Worker to flush zombie deployments (not part of the security model). The Cloudflare bug report is drafted, not filed.

## Notes (2026-10-09)

**Zombie behaviour re-verified.** Read-only `GET /api/health`, 3 requests per Preview URL of PRs #63–#82 and of a name that never existed, at about 07:31Z (#80's response body re-read at 07:35Z):

- 3/3 `503 {"ok":false,"db":"down"}` from deleted Previews of PRs whose close-cleanup succeeded: #73 (closed 7.5 h earlier), #75, #77, #78, #79, #80 and #82. The deleted deployments' code still runs, and none reached a database: the per-PR revocation held.
- 3/3 generic 404 with `x-preview-user-error: true`, the same as the never-existed name: #63–#72, #74, #76 and #81. Of these, #68–#72 and #76 had a successful preview run (#76 closed 1.6 h earlier); #63, #64 and #66 executed (503) when checked on 2026-10-05 at about 05:20Z; #67, #74 and #81 had no preview run.
- So some deleted Previews answer 404 hours or days after deletion while others still execute; these probes don't show whether a 404 is permanent. Decision 1 is unchanged: a 404 still proves nothing, and deleting the per-PR Hyperdrive config stays the boundary. The Cloudflare bug report is still not filed.

**Previews stay public on workers.dev; no Cloudflare Access.** Why that is acceptable today:

- Data: each preview's branch is reset from `preview-seed` (synthetic) in the separate preview Neon project and never holds production data (AGENTS.md invariant 15).
- Credentials: a preview gets only a random `BETTER_AUTH_SECRET` generated for that deploy, Turnstile's public always-pass test keys (refused outside localhost and workers.dev, ADR-0025), no email binding (ADR-0024) and no billing provider. Sign-up is open and email verification is off, so the workers.dev URL is the only thing that admits a visitor.
- Revocation: closing a PR deletes its Hyperdrive config, so a zombie reaches no database (above).
- Cost of Access: a new Cloudflare product (its own ADR, invariant 14) plus a service token for the preview E2E job, a new secret in the `preview` environment.

Revisit (Access ADR) before a preview gets anything non-synthetic or a real credential (production data, a live billing provider, real email delivery, a production secret), or if abuse of a preview URL shows up (cost, sign-up spam).

## Notes (2026-10-14)

**Dependabot PRs get no preview** (owner decision). `preview.yml` and `docs-preview.yml` skip branches starting with `dependabot/`, as they skip `release-please--*`. A dependency bump is gated by CI's `check + test` (which includes the unit and integration suites against Postgres) and by the owner's merge; the preview's E2E run against a Neon branch added little for it and held one of the preview project's 10 branches per open Dependabot PR. A branch name only decides whether a preview is skipped, so a human branch named `dependabot/…` can only lose its own preview.

## Notes (2026-10-15)

**Documentation-only PRs get no app preview** (owner decision, to save Actions minutes). `preview.yml`'s `resolve` already skips a PR that changes only the static sites. It now also skips one whose files are all under `docs/**` or are root-level `*.md` (AGENTS.md, CLAUDE.md, README.md). The app doesn't build from either. Same rules as before: a rename counts at both paths, and an incomplete file list keeps the preview. Such a PR is still gated by CI's `check + test`.

## Notes (2026-10-21)

CI skips the app suite for a PR confined to `docs/**`, root `*.md`, `apps/docs/**` and `apps/site/**`. A `changes` job (`dorny/paths-filter`, pinned) classifies the PR; a rename counts at both paths. Such a PR still runs the bindings/secrets guards and `pnpm check` (lint, formatting, typecheck including `astro check`, plans and Worker types drift) in `check + test`, and skips Postgres (its service image is empty), migrations, tests, the app build, the preview artifact and E2E; the static-site workflows still build the affected sites. This supersedes the 2026-10-15 note that documentation-only PRs run the full suite. Any other or mixed change, a missing classification, a PR with no files or more than 3,000 (the files API's limit, past which the list may be incomplete) and every push to `main` run the full suite; a failed `changes` job fails CI. On a private repository (such as a copy of this template) the extra job costs one billed minute per run. The preview classifier and trusted boundary are unchanged.
