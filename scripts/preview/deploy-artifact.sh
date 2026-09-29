#!/usr/bin/env bash
# Trusted preview deploy (ADR-0013 step 3): deploys a PR's build artifact without running any of
# the PR's code. This checkout must be the PR's BASE commit (trusted scripts and lockfile); the
# artifact is data only:
#   $ARTIFACT_DIR/apps/web/dist        the PR's `pnpm build` output
#   $ARTIFACT_DIR/packages/db/drizzle  the PR's migrations (SQL + drizzle-kit journal)
# Never imports the build's `.wrangler/deploy/config.json` redirect: the artifact's
# dist/server/wrangler.json is validated and patched (prepare-config.mjs), then passed explicitly.
# Migrations run through the base commit's migrator, not the PR's drizzle config.
# Usage: PR_NUMBER=123 ARTIFACT_DIR=/path/to/artifact PREVIEW_HYPERDRIVE_SLOTS=... GH_TOKEN=... \
#   scripts/preview/deploy-artifact.sh   (GH_TOKEN: reads which PRs are open, to reuse their slots)
# Output: in GitHub Actions writes `url=<preview URL>` to $GITHUB_OUTPUT; otherwise prints it.
# SECURITY: stdout is reserved for workflow commands (::add-mask::); never capture it.
source "$(dirname "$0")/lib.sh"
: "${PR_NUMBER:?}" "${ARTIFACT_DIR:?}"
names_for "$PR_NUMBER"

artifact="$(cd "$ARTIFACT_DIR" && pwd -P)"
config="$artifact/apps/web/dist/server/wrangler.json"
migrations="$artifact/packages/db/drizzle"
# The artifact must be plain files: a symlink could point the config or assets outside it.
if [ -n "$(find "$artifact" -type l -print -quit)" ]; then
  log "ERROR: artifact contains symlinks; refusing it"
  exit 1
fi
[ -f "$config" ] || { log "ERROR: artifact has no apps/web/dist/server/wrangler.json"; exit 1; }
[ -f "$migrations/meta/_journal.json" ] || { log "ERROR: artifact has no packages/db/drizzle journal"; exit 1; }
# Validate before touching any cloud resource; the real Hyperdrive id is patched in below.
node "$ROOT/scripts/preview/prepare-config.mjs" "$config" "$CLOUDFLARE_ACCOUNT_ID"
cf_token_preflight

# ADR-0019: a pre-provisioned slot (Neon branch + Hyperdrive config); CI creates neither.
claim_slot "$PR_NUMBER"
reset_slot_db
log "migrating slot $SLOT (base migrator, PR migrations as data)"
DATABASE_URL="$DB_URL" node "$ROOT/packages/db/scripts/migrate.mjs" "$migrations"

node "$ROOT/scripts/preview/prepare-config.mjs" "$config" "$CLOUDFLARE_ACCOUNT_ID" "$HD_ID"
new_auth_secret
# Cleanup (PR closed) may have released the slot meanwhile: never publish into, or leave a preview
# bound to, a slot another PR may now hold.
owns_slot "$PR_NUMBER" "$SLOT_BRANCH_ID" || { log "ERROR: slot $SLOT is no longer held by PR #$PR_NUMBER"; exit 1; }
deploy_preview --config "$config"
if ! owns_slot "$PR_NUMBER" "$SLOT_BRANCH_ID"; then
  log "ERROR: slot $SLOT was released during the deploy; removing the preview"
  delete_preview_verified "$PREVIEW_NAME" || true
  exit 1
fi
