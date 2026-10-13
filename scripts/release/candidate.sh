#!/usr/bin/env bash
# Release candidate (ADR-0029 decision 3, steps 5–6), with the Worker token only: upload the
# artifact's Worker as a version tagged $TAG, deploy it at 0% next to the live version at 100%, and
# smoke-test it through the version override header. Only this build's id in /api/health proves
# the override reached the candidate (an ignored override falls through to the live version).
# If the smoke test fails the candidate stays at 0%: users never see it.
# Outputs (GITHUB_OUTPUT): candidate_version, live_version.
# Usage: CLOUDFLARE_API_TOKEN=... ARTIFACT_DIR=... TAG=web-vX.Y.Z SHA=<commit> BUILD_ID=<run>-<attempt>
#        scripts/release/candidate.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}" "${ARTIFACT_DIR:?}" "${TAG:?}" "${SHA:?}" "${BUILD_ID:?}"
[[ "$TAG" =~ ^web-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "unexpected tag $TAG"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "unexpected commit $SHA"
[[ "$BUILD_ID" =~ ^[0-9]+-[0-9]+$ ]] || die "unexpected build id $BUILD_ID"

artifact="$(cd "$ARTIFACT_DIR" && pwd -P)"
config="$artifact/apps/web/dist/server/wrangler.json"
# Plain files only, no env files (wrangler would read vars/secrets next to the config), and the
# config must name this Worker, account and production Hyperdrive config.
[ -z "$(find "$artifact" -type l -print -quit)" ] || die "artifact contains symlinks"
[ -z "$(find "$artifact" \( -name '.dev.vars*' -o -name '.env*' \) -print -quit)" ] || die "artifact contains .dev.vars/.env files"
[ -f "$config" ] || die "artifact has no apps/web/dist/server/wrangler.json"
jq -e --arg w "$WORKER" --arg a "$ACCOUNT" --arg h "$PROD_HYPERDRIVE_ID" \
  '.name == $w and .account_id == $a and ([.hyperdrive[]?.id] == [$h])' "$config" >/dev/null ||
  die "artifact config doesn't match the production Worker, account and Hyperdrive config"

dep="$(deployment)"
[ "$(jq '.versions | length' <<<"$dep")" = 1 ] || die "the deployment already holds a candidate"
live="$(jq -r '.versions[0].version_id' <<<"$dep")"

out="$(mktemp)"
WRANGLER_OUTPUT_FILE_PATH="$out" wrangler versions upload --config "$config" \
  --tag "$TAG" --message "commit=$SHA build=$BUILD_ID" >&2
new="$(jq -r 'select(.type == "version-upload") | .version_id' "$out" | tail -n1)"
[[ "$new" =~ ^[0-9a-f-]{36}$ ]] || die "couldn't read the uploaded version id"
log "uploaded $new ($TAG); live is $live"
echo "candidate_version=$new" >>"${GITHUB_OUTPUT:-/dev/null}"
echo "live_version=$live" >>"${GITHUB_OUTPUT:-/dev/null}"

wrangler versions deploy "$new@0%" "$live@100%" --name "$WORKER" --message "candidate $TAG" -y >&2
expect_health "${TAG#web-v}" "$BUILD_ID" "$new" ||
  die "smoke test failed: $new stays at 0% (promote, fix forward, or redeploy the live version alone)"
