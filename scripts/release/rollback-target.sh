#!/usr/bin/env bash
# Rollback, step 1 (ADR-0029 decision 6), with the Worker token only. Resolves:
# - the target: VERSION_ID, or the newest earlier 100% version whose code differs from the live
#   code. Code is identified through code_version (a `wrangler secret put` version runs its
#   predecessor's code), so a secret-put version of an older release is a valid target, and the one
#   that keeps today's secrets. A candidate whose code can't be identified stops the search: pass
#   version_id then.
# - the target's commit, tag and build, from its code version (message `commit=… build=…` and tag,
#   set by release.yml); unknown ones stay empty, and the guard treats them as breaking;
# - secrets_changed: whether a secret changed at or after the target was created
#   (secrets_changed_since). `wrangler rollback` then reverts secret values too without asking in
#   CI, so the workflow refuses unless confirmed.
# Outputs (GITHUB_OUTPUT): target, commit, tag, build, live, secrets_changed.
# Usage: CLOUDFLARE_API_TOKEN=... [VERSION_ID=<id>] scripts/release/rollback-target.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}"

dep="$(deployment)"
[ "$(jq '.versions | length' <<<"$dep")" = 1 ] || die "a candidate is held: run release.yml with action discard (or promote) before rolling back"
live="$(jq -r '.versions[0].version_id' <<<"$dep")"
versions="$(versions_list)"

commit_of() { message_field "$(annotations "$1" | jq -r '.["workers/message"] // empty')" commit; }
# Commit of the code version $1 runs; empty if unknown.
code_commit() {
  local cv
  cv="$(code_version "$1" "$versions")"
  [ -z "$cv" ] || commit_of "$cv"
}
live_commit="$(code_commit "$live")"

target="${VERSION_ID:-}"
if [ -z "$target" ]; then
  # Without the live code's commit, "different code" can't be told: an explicit target is needed.
  [ -n "$live_commit" ] || die "the live code's commit is unknown (not deployed by release.yml, or outside the 10 newest versions): pass version_id"
  out="$(wrangler deployments list --name "$WORKER" --json | json_tail | jq -r --arg l "$live" '
    [.[] | select((.versions | length) == 1 and .versions[0].percentage == 100) | .versions[0].version_id]
    | map(select(. != $l)) | reverse | .[]')"
  earlier=()
  lines_to "$out" earlier
  for v in "${earlier[@]}"; do
    c="$(code_commit "$v")"
    [ -n "$c" ] || die "can't identify the code of earlier version $v: pass version_id"
    [ "$c" != "$live_commit" ] || continue
    target="$v"
    break
  done
fi
[[ "$target" =~ ^[0-9a-f-]{36}$ ]] || die "no rollback target (pass version_id)"
[ "$target" != "$live" ] || die "$target is already live"

code="$(code_version "$target" "$versions")"
tag=''
message=''
if [ -n "$code" ]; then
  ann="$(annotations "$code")"
  tag="$(jq -r '.["workers/tag"] // empty' <<<"$ann")"
  message="$(jq -r '.["workers/message"] // empty' <<<"$ann")"
fi
[[ "$tag" =~ ^web-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || tag=
commit="$(message_field "$message" commit)"
build="$(message_field "$message" build)"
[[ -z "$commit" || "$commit" =~ ^[0-9a-f]{40}$ ]] || die "unexpected commit in $code's message"
[[ -z "$build" || "$build" =~ ^[0-9]+-[0-9]+$ ]] || die "unexpected build id in $code's message"

secrets_changed="$(secrets_changed_since "$target" "$versions")"
log "rollback target $target (code of ${code:-unknown}: ${tag:-untagged}, commit ${commit:-unknown}); live is $live; secrets changed since: $secrets_changed"
{
  echo "target=$target"; echo "commit=$commit"; echo "tag=$tag"; echo "build=$build"
  echo "live=$live"; echo "secrets_changed=$secrets_changed"
} >>"${GITHUB_OUTPUT:-/dev/null}"
