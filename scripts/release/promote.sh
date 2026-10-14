#!/usr/bin/env bash
# Promote the candidate (ADR-0029 decision 3, step 7), with the Worker token only. Refuses unless
# the deployment is still exactly <candidate>@0% + <live>@100% (a rollback or another deploy since
# then makes the promotion stale), then deploys the candidate at 100% and checks /api/health
# without the override header. Without CANDIDATE (dispatch `promote`), the held candidate is the
# deployment's 0% version, and its tag and build id come from its annotations.
# Usage: CLOUDFLARE_API_TOKEN=... [CANDIDATE=<id> LIVE=<id>] scripts/release/promote.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}"

dep="$(deployment)"
[ "$(jq '.versions | length' <<<"$dep")" = 2 ] || die "no candidate held: the deployment has $(jq '.versions | length' <<<"$dep") version(s)"
held="$(jq -r '.versions[] | select(.percentage == 0) | .version_id' <<<"$dep")"
live="$(jq -r '.versions[] | select(.percentage == 100) | .version_id' <<<"$dep")"
[ -n "$held" ] && [ -n "$live" ] || die "the deployment isn't a 0%/100% split: $(jq -c .versions <<<"$dep")"
if [ -n "${CANDIDATE:-}" ]; then
  [ "$held" = "$CANDIDATE" ] && [ "$live" = "${LIVE:?}" ] ||
    die "stale promotion: expected $CANDIDATE@0% + $LIVE@100%, found $held@0% + $live@100%"
fi

ann="$(annotations "$held")"
tag="$(jq -r '.["workers/tag"] // empty' <<<"$ann")"
build="$(message_field "$(jq -r '.["workers/message"] // empty' <<<"$ann")" build)"
[[ "$tag" =~ ^app-v[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -n "$build" ] ||
  die "candidate $held has no release tag/build annotation; refusing to promote it"

log "promoting $held ($tag, build $build) over $live"
wrangler versions deploy "$held@100%" --name "$WORKER" --message "promote $tag" -y >&2
expect_health "${tag#app-v}" "$build" || die "$tag is at 100% but /api/health doesn't report it; check now (rollback.yml)"
echo "### Released $tag" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
