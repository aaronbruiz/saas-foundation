#!/usr/bin/env bash
# Trusted preview deploy (ADR-0013 step 3, ADR-0021): deploys a PR's build artifact without running
# any of the PR's code. Runs only in the `preview` environment, from the default branch's scripts
# and lockfile, with the narrow per-Worker token as CLOUDFLARE_API_TOKEN. It never holds the
# Hyperdrive token: `infra.sh up` (a separate job) created the PR's branch and Hyperdrive config
# and passed the id in HD_ID. The artifact is untrusted data:
#   $ARTIFACT_DIR/apps/web/dist        the PR's `pnpm build` output
#   $ARTIFACT_DIR/packages/db/drizzle  the PR's migrations (SQL + drizzle-kit journal)
# Never imports the build's `.wrangler/deploy/config.json` redirect: the artifact's
# dist/server/wrangler.json is validated and patched (prepare-config.mjs), then passed explicitly.
# Migrations run through the default branch's migrator, not the PR's drizzle config.
# Usage: PR_NUMBER=123 HD_ID=<32 hex> ARTIFACT_DIR=/path GH_TOKEN=... [FORCE=1] scripts/preview/deploy-artifact.sh
# Output: in GitHub Actions writes `url=<preview URL>` to $GITHUB_OUTPUT; otherwise prints it.
# SECURITY: stdout is reserved for workflow commands (::add-mask::); never capture it.
source "$(dirname "$0")/lib.sh"
: "${PR_NUMBER:?}" "${ARTIFACT_DIR:?}" "${HD_ID:?}"
names_for "$PR_NUMBER"
[[ "$HD_ID" =~ ^[0-9a-f]{32}$ ]] || { log "ERROR: HD_ID must be a Hyperdrive id"; exit 1; }
[ "$HD_ID" != "$PROD_HYPERDRIVE_ID" ] || { log "ERROR: refusing to bind the production Hyperdrive config"; exit 1; }

artifact="$(cd "$ARTIFACT_DIR" && pwd -P)"
config="$artifact/apps/web/dist/server/wrangler.json"
migrations="$artifact/packages/db/drizzle"
# The artifact must be plain files: a symlink could point the config or assets outside it.
if [ -n "$(find "$artifact" -type l -print -quit)" ]; then
  log "ERROR: artifact contains symlinks; refusing it"
  exit 1
fi
# No env files: wrangler could read local vars/secrets from them next to the config.
if [ -n "$(find "$artifact" \( -name '.dev.vars*' -o -name '.env*' \) -print -quit)" ]; then
  log "ERROR: artifact contains .dev.vars/.env files; refusing it"
  exit 1
fi
[ -f "$config" ] || { log "ERROR: artifact has no apps/web/dist/server/wrangler.json"; exit 1; }
[ -f "$migrations/meta/_journal.json" ] || { log "ERROR: artifact has no packages/db/drizzle journal"; exit 1; }
# Validate before touching any cloud resource; the real Hyperdrive id is patched in below.
node "$ROOT/scripts/preview/prepare-config.mjs" "$config" "$CLOUDFLARE_ACCOUNT_ID"
cf_worker_preflight

# A close event may have arrived meanwhile: never (re)publish a closed PR's preview. FORCE=1 for
# manual runs (e.g. test PR numbers).
[ -n "${FORCE:-}" ] || pr_is_open "$PR_NUMBER" || { log "PR #$PR_NUMBER isn't open (or its state is unknown); not deploying"; exit 1; }

bid="$(neon_branch_id "$NEON_BRANCH")"
[ -n "$bid" ] || { log "ERROR: no Neon branch $NEON_BRANCH (the infra job creates it)"; exit 1; }
DB_URL="$(neon_connection_uri "$bid")"
[ -n "$DB_URL" ] && [ "$DB_URL" != null ] || { log "ERROR: no connection URI for $NEON_BRANCH"; exit 1; }
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$DB_URL"
log "migrating $NEON_BRANCH (default-branch migrator, PR migrations as data)"
DATABASE_URL="$DB_URL" node "$ROOT/packages/db/scripts/migrate.mjs" "$migrations"
unset DB_URL

node "$ROOT/scripts/preview/prepare-config.mjs" "$config" "$CLOUDFLARE_ACCOUNT_ID" "$HD_ID" "$PROD_HYPERDRIVE_ID"
new_auth_secret
deploy_preview --config "$config"
