#!/usr/bin/env bash
# Rollback, step 1 (ADR-0029 decision 6), with the Worker token only. Resolves, for the target
# VERSION_ID (required; ids from `wrangler deployments list`):
# - its commit, tag and build, from its own annotations (message `commit=… build=…` and tag, set by
#   release.yml). A version not uploaded by release.yml (a manual deploy, or a `wrangler secret put`
#   version) has none: they stay empty, and the guard treats an unknown commit as breaking;
# - secrets_changed: whether a secret changed at or after the target was created
#   (secrets_changed_since). `wrangler rollback` then reverts secret values too without asking in
#   CI, so the workflow refuses unless confirmed.
# Outputs (GITHUB_OUTPUT): target, commit, tag, build, live, secrets_changed.
# Usage: CLOUDFLARE_API_TOKEN=... VERSION_ID=<id> scripts/release/rollback-target.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}" "${VERSION_ID:?}"
target="$VERSION_ID"
[[ "$target" =~ ^[0-9a-f-]{36}$ ]] || die "invalid version_id"

dep="$(deployment)"
[ "$(jq '.versions | length' <<<"$dep")" = 1 ] || die "a candidate is held: run release.yml with action discard (or promote) before rolling back"
live="$(jq -r '.versions[0].version_id' <<<"$dep")"
[ "$target" != "$live" ] || die "$target is already live"

ann="$(annotations "$target")"
tag="$(jq -r '.["workers/tag"] // empty' <<<"$ann")"
message="$(jq -r '.["workers/message"] // empty' <<<"$ann")"
[[ "$tag" =~ ^app-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || tag=
commit="$(message_field "$message" commit)"
build="$(message_field "$message" build)"
[[ -z "$commit" || "$commit" =~ ^[0-9a-f]{40}$ ]] || die "unexpected commit in $target's message"
[[ -z "$build" || "$build" =~ ^[0-9]+-[0-9]+$ ]] || die "unexpected build id in $target's message"

secrets_changed="$(secrets_changed_since "$target" "$(versions_list)")"
log "rollback target $target (${tag:-untagged}, commit ${commit:-unknown}); live is $live; secrets changed since: $secrets_changed"
{
  echo "target=$target"; echo "commit=$commit"; echo "tag=$tag"; echo "build=$build"
  echo "live=$live"; echo "secrets_changed=$secrets_changed"
} >>"${GITHUB_OUTPUT:-/dev/null}"
