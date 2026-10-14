# ADR-0029: Releases, deploys and rollback: release PRs, a 0% release candidate, dispatch and rollback workflows

Status: Accepted (owner 2026-10-13) · Date: 2026-10-13

Moves the production deploy of the app Worker from the owner's machine to CI, as the runbook requires ("wiring it into a deploy workflow needs its own ADR first"). Builds on [ADR-0030](0030-git-workflow.md) (squash-merged Conventional PR titles), [ADR-0013](0013-ci-credential-tiers.md) and [ADR-0021](0021-per-pr-preview-data-behind-a-trusted-boundary.md) (credential tiers, `main`-only environments, trusted jobs), [ADR-0014](0014-first-production-launch-gates.md) (launch gates) and Invariant 10 (forward-safe migrations). The docs Worker's deploys are in [ADR-0028](0028-public-docs-site.md) and follow decisions 5 and 6 here. Research and sources: `.local/research/releases-and-git-workflow.md` (2026-10-13; git-ignored, kept by the owner).

## Context

- **Production deploys are manual today** (runbook "First production deploy"): from a clean checkout of `main`, the owner creates a Neon restore-point branch, runs `pnpm db:migrate`, runs `pnpm run deploy` (which first checks the deployed Worker's email and Turnstile secrets, then builds and runs `wrangler deploy`), and smoke-tests `/api/health`. Rollback is `wrangler rollback`, code only.
- **There are no versions.** No tags, no changelog, no `version` in any `package.json`. What production runs is known only as a Worker version id. The last deploy (2026-10-05, Worker version `5cbca042…`) was `main` at `ef680aa` (#64), per the owner's rollout notes; 24 commits have merged since.
- **Credentials already exist.** The `production` environment (deployment branch `main` only) holds `NEON_API_KEY` (production project; used by `db-backup.yml`) and `CLOUDFLARE_API_TOKEN` (account token `saas-foundation`: Workers Editor on the production Worker only), which no workflow uses yet.
- **GitHub Free, private repo** (ADR-0030): no branch protection, no required reviewers on environments (that needs Enterprise). A human approval step must come from somewhere other than environment rules.
- **`GITHUB_TOKEN` events don't start workflows**, except `pull_request` runs on PRs it opens, which wait for a manual "Approve workflows to run". A GitHub Release created with `GITHUB_TOKEN` therefore can't trigger a separate deploy workflow.
- **Cloudflare versions** (Workers docs, checked 2026-10-13):
  - `wrangler versions upload --tag --message` creates a version without serving it; `wrangler versions deploy <id>@<pct> …` splits traffic, at most two versions per deployment;
  - a request with `Cloudflare-Workers-Version-Overrides: <worker>="<version-id>"` reaches that version **only if it's in the current deployment**, and 0% counts. An override that doesn't apply silently follows the normal split;
  - `wrangler rollback [version-id]` redeploys one of the 100 most recent versions and changes no connected resources;
  - `versions upload` doesn't apply routes or custom domains, and a per-Worker token can't manage custom domains.
- **Neon Free allows 10 branches per project.** The production project holds `main` and up to 3 `backup-*` snapshots (ADR-0023).
- Every migration so far is additive. Invariant 10 (expand → migrate → contract) is what lets the previous version keep running on a migrated schema.

## Decision

### 1. Versions: SemVer per deployable, tagged `web-vX.Y.Z`, by release-please

- **release-please** in manifest mode, action `googleapis/release-please-action` pinned by SHA.
- **One root component `web`** (path `.`, `release-type: node`, `exclude-paths: ["apps/docs"]`). The path is the root, not `apps/web`: `packages/db` (repositories and migrations), `packages/auth`, `packages/contracts` and the lockfile all ship inside the Worker, and a component on `apps/web` would never see their commits. Every future deployable's directory is added to `exclude-paths`.
- **Tags `web-v0.1.0`** (component prefix kept, `include-component-in-tag: true`). Changing the tag shape later breaks release-please's lookup of the previous release, and ADR-0027 expects more deployables. The release date is in the changelog heading and on the GitHub Release.
- **0.x until public launch.** Start at `0.1.0`; `1.0.0` is cut at milestone D (public sign-up, runbook). `bump-minor-pre-major: true`, so a `!` before 1.0 bumps the minor.
- **Bootstrap:** tag the commit production runs today as `web-v0.1.0` (`ef680aa` per the rollout notes; the owner confirms with `wrangler deployments list` first) and set it as `bootstrap-sha`. The first release PR then lists exactly what production is missing.
- **What releases** (`changelog-sections`): visible, and therefore releasable: `feat`, `fix`, `perf`, `refactor`, `revert`. Hidden: `docs`, `test`, `chore`, `ci`, `build`. A `docs(adr): …` PR doesn't cut an empty release, while a refactor, which changes what runs, can ship on its own.
- **Dependency bumps:** Dependabot groups are split by dependency type, so production-dependency bumps are titled `fix(deps): …` (they release) and development-dependency bumps `chore(deps-dev): …` (they don't). A security bump of `better-auth` can then ship without waiting for a feature.
- **Immutable releases on:** a release's tag can't be moved or deleted, so "redeploy tag X" always means the same code.
- **No CalVer.** release-please, changesets, semantic-release, git-cliff and svu compute SemVer only. CalVer would need a custom version calculator and would discard the bump signal the PR titles already carry.

### 2. Release flow: the release PR is the gate

1. Every merge to `main` updates one open release PR (`chore: release web 0.2.0`) with the version bump, `CHANGELOG.md` and the root `package.json` version.
2. The release PR is opened with `GITHUB_TOKEN`, so its CI waits for the owner's **"Approve workflows to run"**. The owner approves, waits for green, then merges. Merging is the approval to deploy. No GitHub App or PAT is added (ADR-0013 minimalism).
3. The merge pushes to `main`; the same `release.yml` run sees `release_created` and runs the deploy job (decision 3) in the `production` environment. A separate `release: published` workflow wouldn't start (`GITHUB_TOKEN`), and a tag ref would be refused by the `main`-only environment.
4. **Hotfix:** merge the fix PR, then merge the refreshed release PR right away. **Emergency:** roll back first (decision 6).
5. `preview.yml` skips `release-please--*` branches: a release PR is open most of the time and would otherwise hold a preview Neon branch.

### 3. App deploy job: migrate, release candidate at 0%, smoke test, promote

Runs on `main`'s code only, in environment `production`. **One lock per Worker:** the release, dispatch and rollback workflows all use `concurrency: { group: deploy-<worker>, cancel-in-progress: false, queue: max }`, as the preview workflows do. Nothing is cancelled, neither a running deploy nor a queued one (GitHub's default would cancel a waiting rollback when a newer run queues), so a rollback can't interleave with a candidate being tested or promoted.

1. **Build without secrets.** A first job checks out the release tag, installs with `--frozen-lockfile` and no dependency cache, builds, and uploads the artifact: the Worker build **and that tag's `packages/db/drizzle` (migration SQL and journal)**. pnpm's `allowBuilds` keeps dependency install scripts off. The build stamps a unique build id (`<run id>-<attempt>`) next to the version (decision 4).
2. **Preflight**, in the `production` job: the existing `check-email-verification.mjs --deployed` and `check-turnstile.mjs --deployed` (they read secret names with the Worker token; one script, `check-secrets.mjs`, since 2026-10-14).
3. **Restore point:** `neon branches create --name pre-migrate-<tag>-<utc> --parent main --no-compute`, confirmed by listing it. Older `pre-migrate-*` branches beyond the newest one are deleted, so with `main` and 3 snapshots the project stays within Neon Free's 10.
4. **Migrate the artifact's migrations, not `main`'s.** `main`'s trusted migrator applies the SQL and journal from the artifact (the pattern of ADR-0021's preview deploy), with a direct connection string read from `NEON_API_KEY`, never printed. A redeploy of an older tag therefore applies nothing new: its journal is a subset of what production already has. Secrets are passed per step, never at job level and never to the install step.
   - **Contract precondition:** if the pending migrations include a contract migration (decision 7), the job first requires that production serves the **immediately preceding release tag at 100%** (from `/api/health`) with no candidate held at 0%. Otherwise it stops before migrating: the version still serving traffic may depend on the shape about to be removed.
5. **Release candidate:** `wrangler versions upload --tag web-vX.Y.Z --message <sha>`, then `wrangler versions deploy <new>@0% <current>@100%`.
6. **Smoke test through the override header:** `GET https://app.<zone>/api/health` with `Cloudflare-Workers-Version-Overrides` naming the new version must return `ok: true`, `db: "up"`, `version: "X.Y.Z"` **and this build's `build` id**. Only the build id proves the override was applied: an ignored override falls through to the live version, which reports the same `version` and `commit` when the same tag is redeployed.
7. **Promote:** first confirm the deployment is still exactly `<new>@0%` + `<expected live>@100%` (a rollback or another deploy since then makes the promotion stale, and it's refused); then `wrangler versions deploy <new>@100%` and the same health check without the header. If the smoke test fails, the job stops with the new version at 0%: users never saw it, and the owner decides between `promote`, a fix, or deploying the old version alone.
8. Routes, custom domains and cron triggers aren't applied by `versions upload`. A release that changes them is flagged by the job (diff of `routes`/`triggers` in `wrangler.jsonc` against the previous tag) and stops before promotion, and the owner applies them by hand, as ADR-0028 does for the docs domain.

**Dispatch inputs** (`workflow_dispatch` on `main`; a tag ref would be refused by the environment):

| Input             | Does                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hold: true`      | On a release, stop after step 6 with the new version at 0%, so the owner can test it by hand with the override header                                         |
| `promote`         | Finish a held release: step 7                                                                                                                                 |
| `redeploy: <tag>` | Rebuild and deploy an existing tag through steps 1–7. Redeploying an **older** tag is a rollback in disguise, so it obeys decision 6's breaking-release guard |

### 4. Version reporting

- `/api/health` returns `{ ok, db, version, commit, build }`: the root `package.json` version, the 7-character commit SHA and the CI build id (`<run id>-<attempt>`; `local` outside CI), injected at build time (Vite `define`) into a server-only module. The build id makes every upload distinguishable, which the override smoke test needs. It stays compatible with the preview scripts, which only check `.ok == true`. The repo is private, so the SHA reveals nothing useful.
- Every upload is tagged (`--tag web-vX.Y.Z --message <sha>`), so the dashboard and `wrangler versions list` show releases, and `wrangler versions deploy --version-tag` can address them.
- No `version_metadata` binding: it would be a new binding under Invariant 14, and the build constant already answers "what is live". Deferred below.

### 5. Docs Worker

Continuous: every merge to `main` that can change the docs build deploys it at 100%, with no release PR, no tags and no 0% stage (ADR-0028). It has no data and its rollback is instant. It gets the same `workflow_dispatch` redeploy (by commit) and rollback as decision 6. Its version is the commit SHA (`--tag docs-<sha7>`, and a static `/version.json`).

### 6. Rollback

- **`rollback.yml`** (`workflow_dispatch` on `main`, per Worker): `wrangler rollback [version-id]`, defaulting to the previous version, with a required `reason` passed as the message. It needs no build, so it takes seconds. Code only.
- **Breaking-release guard, based on what production has applied:** the workflow reads production's applied migrations (`drizzle.__drizzle_migrations`) and compares them with the target version's migration journal (the target's tag, or its commit from the version's `--message`). If production has applied a contract migration (decision 7) that the target doesn't contain, it lists those migrations and refuses unless the input `confirm_breaking: true` is set. Comparing applied migrations, not deployed releases, also covers a release whose migration ran but whose candidate failed or was held.
- **The database is never rolled back by a workflow.** Restoring loses writes since the restore point, so it stays a manual runbook procedure (runbook "Database") using the `pre-migrate-*` branch or a snapshot.
- To verify before relying on it: `wrangler rollback` with the per-Worker token, and whether rolling back to a version created before a `wrangler secret put` restores old secret values (test on the preview Worker).

### 7. Breaking changes = contract migrations

- A PR whose migration drops, renames or retypes anything (`DROP`, `RENAME`, `ALTER … TYPE` in `packages/db/drizzle/*.sql`) must have `!` in its title (`feat(db)!: drop legacy_status`). A CI check fails the PR if such a migration exists and the title has no `!`.
- release-please then lists it under **BREAKING CHANGES** in the release PR, which is exactly when the owner needs to know that rolling back past this release is no longer code-only.
- Expand → migrate → contract still applies (Invariant 10): the contract step ships in its own release, after the release that stopped using the old shape, and the deploy job enforces that this earlier release is live first (decision 3, step 4).

## Alternatives

| Option                                                               | Why not                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy every merge to `main` (continuous deployment for the app)     | Every merge would migrate production and deploy, with no batching and no moment of control. Kept for docs only, which have no data                                                                      |
| Tags pushed by hand trigger the deploy                               | Duplicates `workflow_dispatch`, and a mistyped tag deploys the wrong thing. Dispatch is a form with an audit trail                                                                                      |
| CalVer (`2026.10.2`, workerd's `1.20261013.0`), with bump-my-version | No release-PR tool computes it, so it would need a custom calculator and changelog. bump-my-version writes versions but reads no commits and opens no PR. The date is already on every release          |
| changesets                                                           | Versions come from per-PR changeset files, a second change record next to the Conventional title. It suits npm libraries (workers-sdk, Vercel)                                                          |
| semantic-release                                                     | Releases on every push, with no release PR; that contradicts the owner's "release PR as the gate"                                                                                                       |
| git-cliff, release-drafter, auto-changelog, svu                      | Changelog renderers or version printers, not a release PR. release-please covers what they do                                                                                                           |
| A PAT or GitHub App token for release-please                         | CI would start on release PRs without a click, at the cost of a long-lived write credential. A classic PAT stored at repo level would break ADR-0013                                                    |
| Semver prereleases (`web-v0.5.0-rc.1`) for release candidates        | release-please's prerelease mode is built around prerelease branches (contradicts ADR-0030). Nobody installs a SaaS RC; the 0% version is the real candidate, tested in production with the exact build |
| A 10% gradual stage before 100%                                      | Little signal at current traffic; the override smoke test exercises the new version with production bindings first                                                                                      |
| Deploy straight to 100%                                              | A bad build reaches every user before any check                                                                                                                                                         |
| Required reviewers on `production`                                   | Not available on a private repo without Enterprise. The release PR merge and the owner's workflow approval are the human gates                                                                          |
| `version_metadata` binding                                           | A new binding (Invariant 14) for information the build constant already provides                                                                                                                        |

## Security

- The deploy and rollback jobs run only `main`'s workflow code, in `production`. No PR code runs next to a production credential (ADR-0021). The build job holds no secret.
- The Worker token is per-Worker (Editor on `saas-foundation` only). As ADR-0021 notes, a Worker token can deploy a version bound to any Hyperdrive id; here that's the production config anyway, so the token is a production-data credential by design and lives only in `production`.
- The override header lets anyone who knows a 0% version's id (a random UUID) reach it while it's in the deployment. It runs the same production bindings and checks as the live version, and holds stay short.
- The environment fence (`main` only) works on this Free private repo but is undocumented there (ADR-0030, Deferred: GitHub Pro).

## Deferred

| Decision                                | Options                                                                                                                                                                                                         | Trigger                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Rollback-safety CI                      | run the previous release's test suite against the migrated schema                                                                                                                                               | the first contract migration (`!`, decision 7)                                       |
| Per-tenant beta features                | a flags table in `packages/db`, or per-organization entitlement overrides kept apart from billing (ADR-0020)                                                                                                    | the first feature shipped to some tenants only; needs its own ADR                    |
| `version_metadata` binding              | runtime access to the Cloudflare version id                                                                                                                                                                     | gradual deployments in routine use, or logs that must be correlated with version ids |
| Gradual percentages (10% → 100%)        | a `percentage` dispatch input                                                                                                                                                                                   | enough traffic that a partial rollout gives signal                                   |
| A second versioned deployable (e.g. Go) | another release-please component (`<name>-v0.1.0`); for a binary, GoReleaser Pro (`monorepo.tag_prefix`) or open-source nfpm with the version from release-please; open-source goreleaser rejects prefixed tags | its ADR under ADR-0027                                                               |
| GitHub App token for release PRs        | CI runs on release PRs without the approval click                                                                                                                                                               | the click becomes a recurring delay, or a second maintainer joins                    |

## Consequences

- Production deploys move to CI: the owner's actions become "approve workflows, merge the release PR", and the restore point, migration, candidate and smoke test always run in the same order. The runbook's manual sequence stays as the fallback when CI is unavailable.
- `CLOUDFLARE_API_TOKEN` in `production` gets its first consumer, and `NEON_API_KEY` its second (after `db-backup.yml`).
- Each release costs one Neon branch while it's the newest restore point.
- The first `fix(deps)` bump after adoption will cut a release by itself, by design.
- A mistyped release type (`chore:` for a real fix) doesn't release until corrected with `BEGIN_COMMIT_OVERRIDE` in the merged PR's body.
- Follow-up PRs after acceptance: `release-please-config.json` and `.release-please-manifest.json`, root `version`, `release.yml`, `rollback.yml`, the migration-title check, the preview skip, Dependabot group split, `/api/health` fields, the owner's bootstrap tag and immutable-releases setting, and runbook sections "Releases" and "Rollback" replacing the manual deploy as the default.

## Notes (2026-10-13)

**Bootstrap commit: `8f1290e` (#85), not `ef680aa` (inferred).** `wrangler deployments list` (read-only) shows two code deploys (`workers/triggered_by: deployment`) after `5cbca042`: `1b4ff7cb` at 2026-10-05 15:14:15Z and `f7fb7d1f` at 2026-10-09 15:47:24Z, which serves 100% today. The owner's shell history has `pnpm run deploy` at 15:13:41Z and 15:47:02Z. The main checkout's reflog has `main` pulled to `d7200f0` (#72) at 15:12:59Z and to `8f1290e` (#85) at 14:19:15Z, with no checkout or pull between that and the deploy. Neither record shows the directory the deploy ran in or whether the checkout was clean; assuming the main checkout, as the runbook prescribes, production runs `8f1290e`. `bootstrap-sha` uses it (the owner delegated this choice, 2026-10-13), so the first release PR lists everything merged since (#86 onwards); the `web-v0.1.0` tag goes on the same commit. If production in fact ran an older commit, the changelog would miss what lies between it and `8f1290e`; the first release's deploy replaces whatever runs either way.

**Implementation details beyond the decision text** (`release.yml`, `rollback.yml`, `scripts/release/`): a push-triggered release is held with the repository variable `RELEASE_HOLD=true` (a push has no dispatch input); a version's message is `commit=<sha> build=<run id>-<attempt>`, so `promote` and `rollback.yml` can recover the build id and commit; the routes/triggers check compares `apps/web/wrangler.jsonc` at the tag and at the **live** release's tag (an untagged live version holds, so the first release holds); a new release, redeploy or rollback is refused while a candidate is held, and a `discard` dispatch drops a held candidate; the tag must be on `main`'s history; the breaking-release guard runs on every deploy (not only redeploys), and an automatic release deploys only the newest `web-v*` tag (a re-run of an older one is refused; going back is a `redeploy`); the restore point is created only when migrations are pending, and the newest 2 are kept; the contract precondition also requires the deployment's live tag to be the preceding one; a pending journal entry older than the newest applied migration stops the release (drizzle would skip it); `ALTER … SET SCHEMA` counts as a contract migration; a rollback past a secret change (`workers/triggered_by: secret`) needs `confirm_secret_revert`, since wrangler restores old secret values without asking in CI. A `wrangler secret put` version (no tag or message) counts as the release whose code it runs (the newest non-secret version before it; a timestamp tie or a version outside the 10 listed is "unknown"), for the live tag and the rollback default, which picks the newest earlier version with different code (a secret-put version of an older release qualifies and keeps today's secrets) and needs an explicit `version_id` when the code can't be identified. The release artifact uploads no source maps (as previews; the build emits none). The contract check fails closed: any SQL comment other than drizzle-kit's `--> statement-breakpoint` counts as a contract (a comment could split a keyword pair, and stripping comments safely needs a lexer), and the keywords match anywhere, strings included. These came from an adversarial review (Codex and a Claude subagent, 2026-10-13).

## Notes (2026-10-14)

**Simplified after an over-engineering audit** (Claude and Codex, owner-approved). Decision 6's default target is dropped: `rollback.yml` requires `version_id` (ids from `wrangler deployments list`), so the history search and the code inference for `wrangler secret put` versions are gone. A secret-put version is now taken as it is: as the live version it's "untagged" (the next release holds at 0%), and as a rollback target its commit is unknown, so the breaking-release guard needs `confirm_breaking` (or pick the tagged release before it, with `confirm_secret_revert`). Decision 3 step 8 now holds on **any** change to `apps/web/wrangler.jsonc` since the live release tag, not only `routes`/`triggers` (a one-line `git diff`; a `compatibility_date` bump also holds). The two deployed-secret checks of step 2 are one script, `scripts/check-secrets.mjs`. The Neon REST and artifact-file helpers are shared with the preview scripts (`scripts/common.sh`). The secret-change guard, the breaking-release guard, the contract precondition and the held-candidate refusals are unchanged.
