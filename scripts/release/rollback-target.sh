#!/usr/bin/env bash
# Rollback, step 1 (ADR-0029 decision 6), with the Worker token only. Resolves:
# - the target: VERSION_ID, or the newest earlier 100% version with different code (skipping
#   versions made by `wrangler secret put`, and ones whose `commit=` equals the live one's, e.g. a
#   redeploy of the live tag);
# - its commit, tag and build (from its message `commit=… build=…` and tag, set by release.yml); a
#   version without them (a manual deploy) leaves them empty, and the guard treats it as breaking;
# - secrets_changed: whether a secret changed after the target was created (a version annotated
#   `workers/triggered_by: secret`). `wrangler rollback` then reverts secret values too without
#   asking in CI, so the workflow refuses unless confirmed. A target older than the 10 versions
#   `wrangler versions list` returns counts as changed.
# Outputs (GITHUB_OUTPUT): target, commit, tag, build, live, secrets_changed.
# Usage: CLOUDFLARE_API_TOKEN=... [VERSION_ID=<id>] scripts/release/rollback-target.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}"

dep="$(deployment)"
[ "$(jq '.versions | length' <<<"$dep")" = 1 ] || die "a candidate is held: run release.yml with action discard (or promote) before rolling back"
live="$(jq -r '.versions[0].version_id' <<<"$dep")"
versions="$(wrangler versions list --name "$WORKER" --json | json_tail)"
jq -e 'type == "array" and length > 0' <<<"$versions" >/dev/null || die "couldn't list versions"

commit_of() { message_field "$(annotations "$1" | jq -r '.["workers/message"] // empty')" commit; }
live_commit="$(commit_of "$live")"

target="${VERSION_ID:-}"
if [ -z "$target" ]; then
  out="$(wrangler deployments list --name "$WORKER" --json | json_tail | jq -r --arg l "$live" '
    [.[] | select((.versions | length) == 1 and .versions[0].percentage == 100) | .versions[0].version_id]
    | map(select(. != $l)) | reverse | .[]')"
  earlier=()
  lines_to "$out" earlier
  for v in "${earlier[@]}"; do
    trig="$(jq -r --arg v "$v" '.[] | select(.id == $v) | .annotations["workers/triggered_by"] // empty' <<<"$versions")"
    [ "$trig" != secret ] || continue
    c="$(commit_of "$v")"
    [ -n "$live_commit" ] && [ "$c" = "$live_commit" ] && continue
    target="$v"
    break
  done
fi
[[ "$target" =~ ^[0-9a-f-]{36}$ ]] || die "no rollback target (pass version_id)"
[ "$target" != "$live" ] || die "$target is already live"

ann="$(annotations "$target")"
tag="$(jq -r '.["workers/tag"] // empty' <<<"$ann")"
[[ "$tag" =~ ^web-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || tag=
message="$(jq -r '.["workers/message"] // empty' <<<"$ann")"
commit="$(message_field "$message" commit)"
build="$(message_field "$message" build)"
[[ -z "$commit" || "$commit" =~ ^[0-9a-f]{40}$ ]] || die "unexpected commit in $target's message"
[[ -z "$build" || "$build" =~ ^[0-9]+-[0-9]+$ ]] || die "unexpected build id in $target's message"

created="$(jq -r --arg t "$target" '.[] | select(.id == $t) | .metadata.created_on // empty' <<<"$versions")"
if [ -z "$created" ]; then
  secrets_changed=true # older than the listed versions: can't tell
else
  secrets_changed="$(jq -r --arg c "$created" '[.[] | select(.metadata.created_on > $c
    and .annotations["workers/triggered_by"] == "secret")] | length > 0' <<<"$versions")"
fi
log "rollback target $target (${tag:-untagged}, commit ${commit:-unknown}); live is $live; secrets changed since: $secrets_changed"
{
  echo "target=$target"; echo "commit=$commit"; echo "tag=$tag"; echo "build=$build"
  echo "live=$live"; echo "secrets_changed=$secrets_changed"
} >>"${GITHUB_OUTPUT:-/dev/null}"
