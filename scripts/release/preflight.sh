#!/usr/bin/env bash
# Release preflight (ADR-0029 decision 3, step 2), with the Worker token only: the deployed
# Worker's secrets pass check-secrets.mjs, and no candidate is held at 0% (a new release would
# otherwise replace the deployment the owner is testing; `promote` or `discard` it first).
# Output (GITHUB_OUTPUT): live_tag, the live version's release tag. A version without one (a manual
# deploy, or a `wrangler secret put` version) is "untagged", which holds the release at 0%.
# Usage: CLOUDFLARE_API_TOKEN=... scripts/release/preflight.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}"

(cd "$ROOT/apps/app" && pnpm exec node ../../scripts/check-secrets.mjs --deployed)

dep="$(deployment)"
count="$(jq '.versions | length' <<<"$dep")"
[ "$count" = 1 ] || die "the deployment has $count versions (a candidate is held): run release.yml with action promote or discard first"
live="$(jq -r '.versions[0].version_id' <<<"$dep")"
tag="$(annotations "$live" | jq -r '.["workers/tag"] // empty')"
# Only a release tag counts (and reaches GITHUB_OUTPUT); anything else is "untagged".
[[ "$tag" =~ ^app-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || tag=
log "live: $live (${tag:-untagged}) at 100%"
echo "live_tag=$tag" >>"${GITHUB_OUTPUT:-/dev/null}"
