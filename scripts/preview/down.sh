#!/usr/bin/env bash
# Tear down a PR's preview (ADR-0019). Idempotent.
# - Slot: wipe its data (reset to the seed), delete the preview, release the slot; quarantine the
#   slot instead if the old preview URL keeps serving.
# - Legacy per-PR resources (ADR-0011: branch `preview/pr-N` + Hyperdrive `saas-pr-N`), for PRs
#   deployed before slots. Needs Hyperdrive access; skipped with the narrow per-Worker token.
# Usage: PR_NUMBER=123 [PREVIEW_HYPERDRIVE_SLOTS=...] scripts/preview/down.sh
source "$(dirname "$0")/lib.sh"
: "${PR_NUMBER:?}"
names_for "$PR_NUMBER"
cf_token_preflight

released=""
if [ -n "${PREVIEW_HYPERDRIVE_SLOTS:-}" ]; then
  entry="$(slot_branches | jq -c --arg s "/pr-$PR_NUMBER" '[.[] | select(.name | endswith($s))][0] // empty')"
  if [ -n "$entry" ]; then
    rc=0
    release_slot "$(jq -r .slot <<<"$entry")" "$(jq -r .id <<<"$entry")" "$PR_NUMBER" || rc=$?
    # Quarantine is a handled outcome; anything else fails the job (the janitor retries).
    [ "$rc" = 0 ] || [ "$rc" = 2 ] || exit 1
    released=1
  fi
fi

# Legacy: data first (Hyperdrive config, then branch), then the preview.
if hd_list="$(cf_api /hyperdrive/configs 2>/dev/null)"; then
  hd_id="$(jq -r --arg n "$HYPERDRIVE_NAME" '.result[] | select(.name == $n) | .id' <<<"$hd_list" | head -n1)"
  if [ -n "$hd_id" ]; then
    log "deleting legacy Hyperdrive $HYPERDRIVE_NAME ($hd_id)"
    wrangler hyperdrive delete "$hd_id" >&2
  fi
else
  log "no Hyperdrive access (per-Worker token): skipping legacy per-PR Hyperdrive cleanup"
fi
if neon_branch_exists "$NEON_BRANCH"; then
  log "deleting legacy Neon branch $NEON_BRANCH"
  neon branches delete "$NEON_BRANCH" --project-id "$NEON_PREVIEW_PROJECT_ID" --output json >/dev/null
fi
if [ -z "$released" ]; then
  rc=0
  delete_preview_verified "$PREVIEW_NAME" || rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 2 ] || exit 1
fi

log "done: pr-$PR_NUMBER"
