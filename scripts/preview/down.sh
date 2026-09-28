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
# In CI the slots must be known, or a PR's slot would never be released (fail closed).
if [ -n "${GITHUB_ACTIONS:-}" ] && [ -z "${PREVIEW_HYPERDRIVE_SLOTS:-}" ]; then
  log "ERROR: PREVIEW_HYPERDRIVE_SLOTS is not set"
  exit 1
fi
# A delayed close event can arrive after the PR was reopened: destroy nothing unless GitHub says
# it's closed right now. FORCE=1 for manual runs (e.g. test PR numbers).
if [ -z "${FORCE:-}" ] && ! pr_is_closed "$PR_NUMBER"; then
  log "PR #$PR_NUMBER isn't closed (or its state is unknown); nothing to do"
  exit 0
fi
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
hd_list="$(legacy_hyperdrive_json)"
hd_id="$(jq -r --arg n "$HYPERDRIVE_NAME" '.result[] | select(.name == $n) | .id' <<<"$hd_list" | head -n1)"
if [ -n "$hd_id" ]; then
  log "deleting legacy Hyperdrive $HYPERDRIVE_NAME ($hd_id)"
  wrangler hyperdrive delete "$hd_id" >&2
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
