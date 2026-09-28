#!/usr/bin/env bash
# Create or update the preview for one PR (ADR-0011) from this checkout: builds and migrates with
# the checked-out code. Idempotent: safe to re-run on every push. Replaced in CI by
# deploy-artifact.sh (ADR-0013 step 3), which never runs PR code next to credentials.
# Usage: PR_NUMBER=123 scripts/preview/up.sh
# Output: in GitHub Actions writes `url=<preview URL>` to $GITHUB_OUTPUT; otherwise prints it.
# SECURITY: stdout is reserved for workflow commands (::add-mask::). Never capture this script's
# stdout, never print the connection string. (A captured stdout leaked a masked URL once: PR #4.)
source "$(dirname "$0")/lib.sh"
: "${PR_NUMBER:?}"
names_for "$PR_NUMBER"
cf_token_preflight

ensure_preview_db
log "migrating $NEON_BRANCH"
DATABASE_URL="$DB_URL" pnpm --dir "$ROOT" db:migrate >&2
ensure_hyperdrive

# Point the committed fail-closed previews sentinel at this PR's Hyperdrive config, BEFORE the
# build (the Vite plugin bakes config). Idempotent: re-runs replace the id.
node "$ROOT/scripts/preview/inject-previews.mjs" "$ROOT/apps/web/wrangler.jsonc" "$HD_ID"
# Secret generated before the build so the bundle scan checks it too.
new_auth_secret
pnpm --dir "$ROOT" build >&2
BETTER_AUTH_SECRET="$AUTH_SECRET" "$ROOT/scripts/scan-client-bundle.sh" "$ROOT/apps/web/dist/client"

deploy_preview
