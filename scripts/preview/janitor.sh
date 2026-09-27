#!/usr/bin/env bash
# Remove preview resources whose PR is no longer open (ADR-0011). Needs GH_TOKEN for `gh`.
source "$(dirname "$0")/lib.sh"

open="$(gh pr list --state open --limit 200 --json number --jq '.[].number' | sort -u)"
# Candidates: leftover Neon branches and Hyperdrive configs, plus recently closed PRs
# (previews can't be listed, so re-deleting them for closed PRs catches orphaned previews).
candidates="$( {
  neon_branches_json | jq -r '.[].name | select(startswith("preview/pr-")) | ltrimstr("preview/pr-")'
  cf_api /hyperdrive/configs | jq -r '.result[].name | select(startswith("saas-pr-")) | ltrimstr("saas-pr-")'
  gh pr list --state closed --limit 30 --json number --jq '.[].number'
} | sort -u)"

for n in $candidates; do
  if printf '%s\n' "$open" | grep -qx "$n"; then continue; fi
  log "cleaning up closed PR #$n"
  PR_NUMBER="$n" "$(dirname "$0")/down.sh" || log "WARN: cleanup of #$n failed; will retry next run"
done
