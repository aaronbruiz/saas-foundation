#!/usr/bin/env bash
# Restore point before migrating (ADR-0029 decision 3, step 3), run by migrate.sh only when
# migrations are pending: a Neon branch of production `main` without compute,
# `pre-migrate-<tag>-<utc>`, confirmed by listing it. Then `pre-migrate-*` branches beyond the
# newest 2 are deleted (Neon Free: 10 branches per project), so a later release can't prune the
# only point from before an earlier, failed migration. A prune that fails (e.g. a branch with
# children after a restore) is a warning, not a stopped release.
# Restoring from it is the manual runbook procedure ("Database"), never a workflow.
# Usage: NEON_API_KEY=... NEON_PROJECT_ID=... TAG=web-vX.Y.Z scripts/release/restore-point.sh
source "$(dirname "$0")/lib.sh"
: "${TAG:?}"
[[ "$TAG" =~ ^web-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "unexpected tag $TAG"
KEEP=2

name="pre-migrate-$TAG-$(date -u +%Y%m%dT%H%M%SZ)"
main="$(neon_branch_id main)"
[ -n "$main" ] || die "no Neon branch named main"
# No `endpoints` in the request: the branch gets no compute.
neon_api /branches -X POST -d "$(jq -nc --arg n "$name" --arg p "$main" '{branch: {name: $n, parent_id: $p}}')" >/dev/null
branches="$(neon_api /branches)"
jq -e --arg n "$name" 'any(.branches[]; .name == $n)' <<<"$branches" >/dev/null ||
  die "restore point $name not found after creating it"
log "restore point $name created"

prune=()
old="$(jq -r --argjson k "$KEEP" '[.branches[] | select(.name | test("^pre-migrate-web-v[0-9]+\\.[0-9]+\\.[0-9]+-[0-9]{8}T[0-9]{6}Z$"))]
  | sort_by(.created_at) | reverse | .[$k:][] | "\(.id) \(.name)"' <<<"$branches")"
lines_to "$old" prune
for line in "${prune[@]}"; do
  log "deleting older restore point ${line#* }"
  (neon_api "/branches/${line%% *}" -X DELETE >/dev/null) || log "WARNING: couldn't delete ${line#* }; delete it by hand"
done
