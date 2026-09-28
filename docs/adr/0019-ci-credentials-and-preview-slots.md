# ADR-0019: CI credentials by resource, and pre-provisioned preview slots

Status: Accepted (2026-09-28; rollout below) · Date: 2026-09-28

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
  - The repo-level `NEON_API_KEY` is deleted, and the unused production key and the old personal key are revoked.
  - The key's reach is limited to the project it backs up. The environment keeps it away from PR code.
- Previews: `NEON_PREVIEW_API_KEY` (scoped to the preview project), repo-level, T1. It is never used for production.

**3. Cloudflare: previews need only a per-Worker Editor token.**

- CI's `CLOUDFLARE_API_TOKEN` becomes an **account-owned API token**:
  - permission: Workers role **Editor**, scope **Specified Workers → `saas-foundation-preview`**;
  - nothing else: no Hyperdrive, no zone, no account settings, and no other Worker (production `saas-foundation` included).
  - The previous user token (which could deploy production) is revoked.
- To make that sufficient, CI stops creating Hyperdrive configs (decision 4). The account's `workers.dev` subdomain comes from the CI variable `CLOUDFLARE_WORKERS_SUBDOMAIN` instead of an account-level API call.

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
  - A lingering Preview URL (Previews beta issue) can reach whatever later occupies its slot. Previews hold synthetic data and have open sign-up, so this exposes nothing that isn't already public.
  - Claims aren't atomic. Two PRs starting at the same moment can rarely pick the same slot; the loser notices on re-read and retries. Write access is owner-only, and the worst case is two previews sharing synthetic data.
  - Rotating `app_owner`'s preview password means running `provision-slots.sh` again, since it updates the slot configs.

## Rollout

- [x] Production Hyperdrive created and verified; id pinned.
- [x] Backup/restore drill on the production project (2026-09-28), using the exact commands of `snapshot.sh` and the runbook:
  - marker written to `main`, then a snapshot branch taken, then `main` changed;
  - the snapshot's read-only compute showed the pre-change state and refused writes (SQLSTATE 25006);
  - a writable branch restored from the snapshot showed the same state and accepted writes;
  - drill branches and the marker schema were removed afterwards.
- [ ] Owner: create the production-scoped key and store it in `production` (runbook "CI credentials"); dispatch `db-backup.yml` and see a green run; then delete the repo-level `NEON_API_KEY` and revoke the unused production key and the personal key.
- [ ] Preview slots provisioned (`provision-slots.sh`) and scripts switched (PR "preview slots").
- [ ] Preview job split (ADR-0013 step 3, PR 2).
- [ ] Owner: create the per-Worker token above, replace `CLOUDFLARE_API_TOKEN`, revoke the old user token. Verify with a PR preview run.
