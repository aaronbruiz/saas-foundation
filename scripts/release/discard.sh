#!/usr/bin/env bash
# Discard a held or failed candidate (release.yml `discard`), with the Worker token only: when the
# deployment is a 0%/100% split, deploy the 100% version alone, so the next release, redeploy or
# rollback can proceed. The candidate's migrations stay applied (expand-only, Invariant 10).
# Usage: CLOUDFLARE_API_TOKEN=... scripts/release/discard.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}"

dep="$(deployment)"
[ "$(jq '.versions | length' <<<"$dep")" = 2 ] || die "no candidate held: the deployment has $(jq '.versions | length' <<<"$dep") version(s)"
held="$(jq -r '.versions[] | select(.percentage == 0) | .version_id' <<<"$dep")"
live="$(jq -r '.versions[] | select(.percentage == 100) | .version_id' <<<"$dep")"
if [ -z "$held" ] || [ -z "$live" ]; then die "the deployment isn't a 0%/100% split: $(jq -c .versions <<<"$dep")"; fi

log "discarding candidate $held; $live stays at 100%"
wrangler versions deploy "$live@100%" --name "$WORKER" --message "discard candidate $held" -y >&2
for _ in $(seq 1 12); do
  [ "$(deployment | jq -c '[.versions[] | [.version_id, .percentage]]')" = "[[\"$live\",100]]" ] && break
  sleep 5
done
[ "$(deployment | jq -c '[.versions[] | [.version_id, .percentage]]')" = "[[\"$live\",100]]" ] || die "the deployment isn't $live alone after discarding"
echo "### Discarded candidate $held" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
