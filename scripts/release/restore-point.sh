#!/usr/bin/env bash
# Restore point before migrating (ADR-0029 decision 3, step 3): a Neon branch of production `main`
# without compute, `pre-migrate-<tag>-<utc>`, confirmed by listing it. Older `pre-migrate-*`
# branches are deleted, keeping the newest only (Neon Free: 10 branches per project).
# Restoring from it is the manual runbook procedure ("Database"), never a workflow.
# Usage: NEON_API_KEY=... NEON_PROJECT_ID=... TAG=web-vX.Y.Z scripts/release/restore-point.sh
source "$(dirname "$0")/lib.sh"
: "${TAG:?}"
[[ "$TAG" =~ ^web-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "unexpected tag $TAG"

name="pre-migrate-$TAG-$(date -u +%Y%m%dT%H%M%SZ)"
main="$(neon_main_id)"
[ -n "$main" ] || die "no Neon branch named main"
# No `endpoints` in the request: the branch gets no compute.
neon_api /branches -X POST -d "$(jq -nc --arg n "$name" --arg p "$main" '{branch: {name: $n, parent_id: $p}}')" >/dev/null
neon_api /branches | jq -e --arg n "$name" 'any(.branches[]; .name == $n)' >/dev/null ||
  die "restore point $name not found after creating it"
log "restore point $name created"
echo "restore_point=$name" >>"${GITHUB_OUTPUT:-/dev/null}"

neon_api /branches | jq -r --arg n "$name" '.branches[] | select(.name | startswith("pre-migrate-")) | select(.name != $n) | "\(.id) \(.name)"' |
  while read -r id old; do
    log "deleting older restore point $old"
    neon_api "/branches/$id" -X DELETE >/dev/null
  done
