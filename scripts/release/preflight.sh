#!/usr/bin/env bash
# Release preflight (ADR-0029 decision 3, step 2), with the Worker token only: the deployed
# Worker's secrets pass the email-verification and Turnstile checks, and no candidate is held at 0%
# (a new release would otherwise replace the deployment the owner is testing; `promote` or `discard` it first).
# Outputs (GITHUB_OUTPUT): live_version, live_tag.
# Usage: CLOUDFLARE_API_TOKEN=... scripts/release/preflight.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}"

(cd "$ROOT/apps/web" && pnpm exec node ../../scripts/check-email-verification.mjs --deployed)
(cd "$ROOT/apps/web" && pnpm exec node ../../scripts/check-turnstile.mjs --deployed)

dep="$(deployment)"
count="$(jq '.versions | length' <<<"$dep")"
[ "$count" = 1 ] || die "the deployment has $count versions (a candidate is held): run release.yml with action promote or discard first"
live="$(jq -r '.versions[0].version_id' <<<"$dep")"
tag="$(annotations "$live" | jq -r '.["workers/tag"] // empty')"
# Only a release tag counts (and reaches GITHUB_OUTPUT); anything else is "untagged".
[[ "$tag" =~ ^web-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || tag=
log "live: $live (${tag:-untagged}) at 100%"
echo "live_version=$live" >>"${GITHUB_OUTPUT:-/dev/null}"
echo "live_tag=$tag" >>"${GITHUB_OUTPUT:-/dev/null}"
