#!/usr/bin/env bash
# Delete the preview, its Hyperdrive config and its Neon branch (ADR-0011). Idempotent.
# Usage: PR_NUMBER=123 scripts/preview/down.sh
source "$(dirname "$0")/lib.sh"
: "${PR_NUMBER:?}"
names_for "$PR_NUMBER"
cf_token_preflight

# Data first: delete the Neon branch and Hyperdrive config BEFORE the preview, so a preview
# URL that lingers after deletion (Cloudflare Previews beta issue) can never reach data.
hd_id="$(hyperdrive_id_by_name "$HYPERDRIVE_NAME")"
if [ -n "$hd_id" ]; then
  log "deleting Hyperdrive $HYPERDRIVE_NAME ($hd_id)"
  wrangler hyperdrive delete "$hd_id" >&2
fi

if neon_branch_exists "$NEON_BRANCH"; then
  log "deleting Neon branch $NEON_BRANCH"
  neon branches delete "$NEON_BRANCH" --project-id "$NEON_PREVIEW_PROJECT_ID" --output json >/dev/null
fi
log "deleting preview $PREVIEW_NAME"
# Only a confirmed "not found" counts as already deleted; any other failure (auth, API, network)
# fails the cleanup instead of reporting success with a live preview.
if ! out="$(wrangler preview delete --name "$PREVIEW_NAME" --skip-confirmation 2>&1)"; then
  if printf '%s' "$out" | grep -q 'Preview not found'; then
    log "no preview $PREVIEW_NAME (already deleted)"
  else
    printf '%s\n' "$out" >&2
    log "ERROR: deleting preview $PREVIEW_NAME failed"
    exit 1
  fi
fi

# Verify the URL actually stopped serving. Observed 2026-09-27 (Previews open beta): pr-4 and pr-5
# kept serving after a successful delete (pr-3 returned 404). Data resources are already gone above.
subdomain="$(cf_api /workers/subdomain | jq -r '.result.subdomain')"
preview_url="https://${PREVIEW_NAME}-${WORKER_NAME:-saas-foundation}.${subdomain}.workers.dev"
status=""
for _ in 1 2 3 4 5 6; do
  status="$(curl -s -o /dev/null -w '%{http_code}' "$preview_url/api/health" || true)"
  [ "$status" = 404 ] && break
  sleep 5
done
if [ "$status" = 404 ]; then
  log "verified: $preview_url returns 404"
else
  log "WARN: $preview_url still returns $status after delete (Cloudflare Previews beta issue); code only: its Neon branch and Hyperdrive config are already deleted"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning title=Preview URL still serving::$preview_url returned $status after wrangler preview delete"
fi

log "done: pr-$PR_NUMBER"
