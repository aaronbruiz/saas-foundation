#!/usr/bin/env bash
# Delete the preview, its Hyperdrive config and its Neon branch (ADR-0011). Idempotent.
# Usage: PR_NUMBER=123 scripts/preview/down.sh
source "$(dirname "$0")/lib.sh"
: "${PR_NUMBER:?}"
names_for "$PR_NUMBER"
cf_token_preflight

log "deleting preview $PREVIEW_NAME"
wrangler preview delete --name "$PREVIEW_NAME" --skip-confirmation >&2 || log "no preview $PREVIEW_NAME"

hd_id="$(hyperdrive_id_by_name "$HYPERDRIVE_NAME")"
if [ -n "$hd_id" ]; then
  log "deleting Hyperdrive $HYPERDRIVE_NAME ($hd_id)"
  wrangler hyperdrive delete "$hd_id" >&2
fi

if neon_branch_exists "$NEON_BRANCH"; then
  log "deleting Neon branch $NEON_BRANCH"
  neon branches delete "$NEON_BRANCH" --project-id "$NEON_PREVIEW_PROJECT_ID" --output json >/dev/null
fi
log "done: pr-$PR_NUMBER"
