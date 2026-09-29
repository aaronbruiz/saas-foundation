#!/usr/bin/env bash
# Frees preview resources of PRs that are no longer open (ADR-0019). Needs GH_TOKEN for `gh`.
# - Slots held by closed PRs → released (or quarantined if their old URL still serves).
# - Quarantined slots → re-delete the old preview; freed once its URL returns 404.
# - Legacy per-PR resources and recently closed PRs' previews → down.sh.
source "$(dirname "$0")/lib.sh"


if [ -n "${PREVIEW_HYPERDRIVE_SLOTS:-}" ]; then
  # Captured first: a failure inside `< <(...)` would escape `set -e` and look like "no slots".
  slots_json="$(slot_branches)"
  while read -r slot id name; do
    [ -n "$slot" ] || continue
    case "$name" in
      "preview/slot-$slot/pr-"*)
        pr="${name##*/pr-}"
        # Asked per PR, right before releasing; any doubt keeps the slot (ADR-0019).
        if pr_is_closed "$pr"; then release_slot "$slot" "$id" "$pr" || log "WARN: slot $slot not released; next run retries"; fi
        ;;
      "preview/slot-$slot/quarantine-pr-"*)
        pr="${name##*/quarantine-pr-}"
        # A reopened PR may have a live preview of the same name again: leave it alone.
        pr_is_closed "$pr" || continue
        rc=0
        delete_preview_verified "pr-$pr" || rc=$?
        if [ "$rc" = 0 ] &&
          neon branches rename "$id" "preview/slot-$slot" --project-id "$NEON_PREVIEW_PROJECT_ID" --output json >/dev/null; then
          log "slot $slot out of quarantine"
        fi
        ;;
    esac
  done < <(jq -r '.[] | "\(.slot) \(.id) \(.name)"' <<<"$slots_json")
fi

# Legacy per-PR branches, plus recently closed PRs (previews can't be listed, so re-deleting them
# catches orphaned ones).
# Each listing is checked on its own: an incomplete scan must fail, not look clean.
from_branches="$(neon_branches_json | jq -r '.[].name | select(startswith("preview/pr-")) | ltrimstr("preview/pr-")')"
hd_list="$(legacy_hyperdrive_json)"
from_hyperdrive="$(jq -r '.result[].name | select(startswith("saas-pr-")) | ltrimstr("saas-pr-")' <<<"$hd_list")"
recently_closed="$(gh pr list --state closed --limit 30 --json number --jq '.[].number')"
candidates="$(printf '%s\n%s\n%s\n' "$from_branches" "$from_hyperdrive" "$recently_closed" | grep -E '^[0-9]+$' | sort -u || true)"
for n in $candidates; do
  pr_is_closed "$n" || continue
  log "cleaning up closed PR #$n"
  PR_NUMBER="$n" "$(dirname "$0")/down.sh" || log "WARN: cleanup of #$n failed; will retry next run"
done
