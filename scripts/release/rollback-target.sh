#!/usr/bin/env bash
# Rollback, step 1 (ADR-0029 decision 6), with the Worker token only: resolve the target version
# (VERSION_ID, or the version that served 100% before the live one) and the commit it was built
# from (`commit=` in its message, set by release.yml). A version without one (a manual deploy)
# leaves the commit empty, and the guard then treats it as breaking.
# Outputs (GITHUB_OUTPUT): target, commit, tag.
# Usage: CLOUDFLARE_API_TOKEN=... [VERSION_ID=<id>] scripts/release/rollback-target.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}"

dep="$(deployment)"
[ "$(jq '.versions | length' <<<"$dep")" = 1 ] || die "a candidate is held: promote it, or redeploy the live tag, before rolling back"
live="$(jq -r '.versions[0].version_id' <<<"$dep")"
target="${VERSION_ID:-}"
if [ -z "$target" ]; then
  target="$(wrangler deployments list --name "$WORKER" --json | json_tail | jq -r --arg l "$live" '
    [.[] | select((.versions | length) == 1 and .versions[0].percentage == 100) | .versions[0].version_id]
    | map(select(. != $l)) | last // empty')"
fi
[[ "$target" =~ ^[0-9a-f-]{36}$ ]] || die "no rollback target (pass version_id)"
[ "$target" != "$live" ] || die "$target is already live"

ann="$(annotations "$target")"
tag="$(jq -r '.["workers/tag"] // empty' <<<"$ann")"
commit="$(message_field "$(jq -r '.["workers/message"] // empty' <<<"$ann")" commit)"
[[ -z "$commit" || "$commit" =~ ^[0-9a-f]{40}$ ]] || die "unexpected commit in $target's message"
log "rollback target $target (${tag:-untagged}, commit ${commit:-unknown}); live is $live"
{ echo "target=$target"; echo "commit=$commit"; echo "tag=$tag"; echo "live=$live"; } >>"${GITHUB_OUTPUT:-/dev/null}"
