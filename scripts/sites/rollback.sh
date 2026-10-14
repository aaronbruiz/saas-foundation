#!/usr/bin/env bash
# Static site rollback (ADR-0029 decision 6, ADR-0028, ADR-0033): `wrangler rollback` of the site's
# Worker to version $VERSION_ID, with the reason as its message. Code (and content) only; a static
# site has no data or secrets, so there's no breaking-release or secret-change guard. Runs in the
# site's environment.
# Usage: SITE=docs CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... VERSION_ID=<id> REASON=... ACTOR=...
#        scripts/sites/rollback.sh
source "$(dirname "$0")/lib.sh"
require_account
: "${CLOUDFLARE_API_TOKEN:?}" "${VERSION_ID:?}" "${REASON:?}" "${ACTOR:?}"
[[ "$VERSION_ID" =~ ^[0-9a-f-]{36}$ ]] || die "invalid version_id"
msg="rollback by $ACTOR: $REASON"
# wrangler caps the rollback message at 120 characters.
[ "${#msg}" -le 120 ] || die "keep '$(printf 'rollback by %s: ' "$ACTOR")<reason>' within 120 characters (now ${#msg})"

# The target must be a version of the site's Worker. A CI deploy's message is its commit, so
# /version.json can confirm it after the rollback; the manual first deploy has none.
view="$(site_wrangler versions view "$VERSION_ID" --name "$SITE_WORKER" --json | json_tail)" ||
  die "no version $VERSION_ID of $SITE_WORKER"
commit="$(jq -r '.annotations["workers/message"] // empty' <<<"$view")"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || commit=""

only() { [ "$(site_wrangler deployments status --name "$SITE_WORKER" --json | json_tail |
  jq -c '[.versions[] | [.version_id, .percentage]]')" = "[[\"$1\",100]]" ]; }
site_wrangler rollback "$VERSION_ID" --name "$SITE_WORKER" -m "$msg" -y >&2
for _ in $(seq 1 24); do only "$VERSION_ID" && break; sleep 5; done
only "$VERSION_ID" || die "the deployment isn't $VERSION_ID alone at 100% after the rollback"
expect_site "https://$SITE_HOST" "$commit" || die "https://$SITE_HOST doesn't serve the target after the rollback"
echo "### $SITE rolled back to $VERSION_ID${commit:+ (${commit::7})}" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
