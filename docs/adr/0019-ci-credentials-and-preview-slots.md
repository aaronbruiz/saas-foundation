# ADR-0019: CI credentials by resource, and pre-provisioned preview slots

Status: Accepted (2026-09-28; rollout complete 2026-09-29, preview slots replaced by ADR-0021) · Date: 2026-09-28

Superseded in part by [ADR-0021](0021-per-pr-preview-data-behind-a-trusted-boundary.md): decision 4 (preview slots, quarantine) and decision 3's claim that the preview credentials can't touch production Hyperdrive (a Worker deploy can bind any Hyperdrive id). The slot model below (decision 4, quarantine, `provision-slots.sh`, `PREVIEW_HYPERDRIVE_SLOTS`) is historical: it was deployed on 2026-09-28 and removed on 2026-09-29, when ADR-0021 restored one Hyperdrive config and one Neon branch per PR. Current preview state: ADR-0021 and the runbook "Previews".

Supersedes in part:

- [ADR-0011](0011-per-pr-preview-neon-branch.md): per-PR Hyperdrive configs and Neon branches become a fixed pool of preview slots;
- [ADR-0013](0013-ci-credential-tiers.md): the T1 Cloudflare token's scope, the production Neon key's name and location, and its rollout list;
- [ADR-0017](0017-production-account-and-custom-domain.md): "the owner creates the production Hyperdrive config"; it exists now.

## Context

Investigated 2026-09-28, with evidence.

**Neon.**

- `db-backup.yml` (`scripts/backup/snapshot.sh`) was the only consumer of a "backup key". It read `NEON_BACKUP_API_KEY` from the `production` environment, which was empty, so scheduled backups would fail.
- Neon has no special backup credential. Any key that can reach the production project works. The name was only a convention for "a least-privilege key in the main-only environment".
- The organization holds:
  - two project-scoped keys: one for the preview project (in use as `NEON_PREVIEW_API_KEY`) and one for the production project (never used);
  - one personal key, which has full account access and was the old CI key.
- The repo-level secret `NEON_API_KEY` is readable by every same-repo PR workflow. Whatever it holds (probably the production-scoped key), its **location** is the problem, not its name.

**Cloudflare** (changelog "Grant teammates and agents access to specific Workers", 2026-09-15; the API token permissions reference).

- Account-owned tokens can carry a Workers role (Editor) scoped to **specified Workers**. A per-Worker Editor can upload versions and previews but can't create Workers.
- **Hyperdrive permissions are account-scoped only.** A token that can create per-PR Hyperdrive configs can also edit or delete the production config. Editing its origin would redirect production database traffic.
- Wrangler's debug log of a real preview deploy and delete (`--worker-name saas-foundation-preview`) shows only Worker-scoped endpoints: `workers/workers/<worker>/previews…` and `workers/scripts/<worker>/assets-upload-session`. The account-level calls came from our own scripts (Hyperdrive list/create/delete, `workers/subdomain`).
- The production Hyperdrive config didn't exist in the production account.

## Decision

**1. Production Hyperdrive.**

- `saas-foundation-prod` was created in the production account: caching disabled, origin = the production Neon project's `main` via its direct (non-pooler) host, database `app`, role `app_owner`. Its id is in `apps/web/wrangler.jsonc`; the fail-closed sentinel is gone.
- Verified beyond existence: the API shows that origin with caching off, and the built Worker ran remotely (`wrangler dev --remote`, an edge preview session, not a deploy) with that binding. `/api/health` returned `{"ok":true,"db":"up"}`.
- Nothing depends on the previous account.

**2. Neon credentials: one key per project, stored where its tier runs.**

- Production: a key **scoped to the production project**, stored only in the `production` environment (deployment branch `main`) as **`NEON_API_KEY`**. That's the name every script already uses, so there's no second name.
  - `db-backup.yml` reads it from there.
  - The repo-level `NEON_API_KEY` is deleted, and the unused production key and the old personal key are revoked. **Until then, any same-repo PR workflow can still read the repo-level copy.** An environment secret doesn't shadow a repo secret for jobs outside the environment.
  - The key's reach is limited to the project it backs up. The environment keeps it away from PR code.
- Previews: `NEON_PREVIEW_API_KEY` (scoped to the preview project), repo-level, T1. It is never used for production.

**3. Cloudflare: previews need only a per-Worker Editor token.**

- CI's `CLOUDFLARE_API_TOKEN` becomes an **account-owned API token**:
  - permission: Workers role **Editor**, scope **Specified Workers → `saas-foundation-preview`**;
  - nothing else: no Hyperdrive, no zone, no account settings, and no other Worker (production `saas-foundation` included).
  - The previous user token (which could deploy production) is revoked.
- To make that sufficient, CI stops creating Hyperdrive configs (decision 4). The account's `workers.dev` subdomain comes from the CI variable `CLOUDFLARE_WORKERS_SUBDOMAIN` instead of an account-level API call.
- **Prerequisite:** the Worker `saas-foundation-preview` must already exist. A per-Worker token can't create Workers, and `wrangler preview` tries `POST …/workers/workers` when the parent is missing. `provision-slots.sh` (admin) checks it, and the deploy script fails with a clear message if it's gone.
- After this rollout, **the preview credentials** can't deploy the production Worker or change production Hyperdrive. (`db-backup.yml`'s production Neon key reaches the production project by design, fenced by the environment.) This holds only **after** the rollout: slots in use, token replaced, old token revoked. Until then, CI's Cloudflare token can create, list and delete Hyperdrive configs account-wide and deploy any Worker.

**4. Preview slots replace per-PR Hyperdrive configs and branches.**

- A fixed pool of `PREVIEW_SLOTS` slots (default 6). Slot _n_ is:
  - Neon branch `preview/slot-n`, a child of `preview-seed` in the preview project;
  - Hyperdrive config `saas-preview-slot-n` (caching disabled) pointing at that branch's endpoint.
- `scripts/preview/provision-slots.sh` creates and repairs slots. It's run by an admin with their own logged-in `wrangler`/`neonctl`, never by CI. Slot Hyperdrive ids go into the CI variable `PREVIEW_HYPERDRIVE_SLOTS` (not secret).
- Per PR, trusted base-commit code:
  - claims a slot by renaming its branch to `preview/slot-n/pr-<PR>`. A slot held by a PR that's no longer open counts as free;
  - **resets the branch to `preview-seed`** on every deploy. Neon keeps the endpoint on reset, so the slot's Hyperdrive config stays valid;
  - migrates, then deploys with the slot's Hyperdrive id.
- On close (and in the janitor): reset the branch (data first), delete the preview, release the slot.
- Consequences:
  - At most `PREVIEW_SLOTS` open PRs have previews at once. Neon Free's 10 branches per project hold the seed, the slots and room for maintenance.
  - Preview data is fresh on every push. It already was effectively, since sessions reset with each deploy's new auth secret.
  - **Slot quarantine:** a lingering Preview URL (Previews beta issue) keeps its old code _and_ its slot's Hyperdrive binding. A released slot therefore goes into quarantine (`preview/slot-n/quarantine`) until that URL returns 404. The janitor re-checks quarantined slots, and claims never pick them. If every slot is busy or quarantined, the deploy fails with "no free preview slot".
  - Claims aren't atomic. Two PRs starting at the same moment can rarely pick the same slot; the loser notices on re-read and retries. Write access is owner-only, and the worst case is two previews sharing synthetic data.
  - Rotating `app_owner`'s preview password means running `provision-slots.sh` again, since it updates the slot configs.

## Rollout

- [x] Production Hyperdrive created and verified; id pinned.
- [x] Backup/restore drill on the production project (2026-09-28), using the exact commands of `snapshot.sh` and the runbook:
  - marker written to `main`, then a snapshot branch taken, then `main` changed;
  - the snapshot's read-only compute showed the pre-change state and refused writes (SQLSTATE 25006);
  - a writable branch restored from the snapshot showed the same state and accepted writes;
  - drill branches and the marker schema were removed afterwards.
- [x] Owner (done 2026-09-29): the repo-level `NEON_API_KEY` is deleted; the production-scoped key is stored in `production`; `db-backup.yml` ran green with it; the personal key is gone. **Correction:** the production-scoped Neon key (`saas-foundation`) is **not** unused and must **not** be revoked. It is the active `NEON_API_KEY` in the `production` environment and is what `db-backup.yml` uses (ADR-0021 rollout; runbook "CI credentials").
- [x] (Historical, removed 2026-09-29 by ADR-0021: slot configs, slot branches and `PREVIEW_HYPERDRIVE_SLOTS` deleted.) Preview slots provisioned (6; `provision-slots.sh`, re-run idempotent) and `PREVIEW_HYPERDRIVE_SLOTS` / `CLOUDFLARE_WORKERS_SUBDOMAIN` set. Scripts hand-tested on the preview project: a reset keeps the endpoint (health OK through the slot's config right after the reset); claim, re-deploy, second PR, release; a real quarantine (a deleted preview kept answering 200) that the janitor keeps.
- [x] Preview job split (ADR-0013 step 3, PR 2): done by ADR-0021 (#26), privileged jobs on `workflow_run` / `pull_request_target` with secrets in `main`-only environments.
- [x] Owner (2026-09-29): the per-Worker token is `CLOUDFLARE_API_TOKEN` in the `preview` environment; Hyperdrive moved to a separate `CLOUDFLARE_PREVIEW_INFRA_TOKEN` in `preview-infra` (ADR-0021); the old user token is no longer used. Verified with PR preview runs (#27, #28).
