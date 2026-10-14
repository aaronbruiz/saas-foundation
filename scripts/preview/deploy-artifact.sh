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
check_artifact_files "$artifact" || exit 1
# Validate before touching any cloud resource; the real Hyperdrive id is patched in below.
node "$ROOT/scripts/preview/prepare-config.mjs" "$config" "$CLOUDFLARE_ACCOUNT_ID"
require_preview_worker || exit 1

# A close event may have arrived meanwhile: never (re)publish a closed PR's preview. A closed or
# merged PR is an intentional skip (cleanup handles its resources); an unknown state still fails.
# FORCE=1 for manual runs (e.g. test PR numbers).
if [ -z "${FORCE:-}" ]; then
  state="$(pr_state "$PR_NUMBER" || true)"
  case "$state" in
    OPEN) ;;
    CLOSED | MERGED)
      log "Preview skipped: PR #$PR_NUMBER is already closed ($state)"
      if [ -n "${GITHUB_ACTIONS:-}" ]; then
        echo "::notice title=Preview skipped::PR #$PR_NUMBER is already closed"
        echo "Preview skipped: PR #$PR_NUMBER is already closed ($state)." >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
      fi
      exit 0
      ;;
    *) log "ERROR: can't read PR #$PR_NUMBER's state; not deploying"; exit 1 ;;
  esac
fi

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
