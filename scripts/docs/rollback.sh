#!/usr/bin/env bash
# Docs rollback (ADR-0029 decision 6, ADR-0028): `wrangler rollback` of the docs Worker to version
# $VERSION_ID, with the reason as its message. Code (and content) only; the docs have no data or
# secrets, so there's no breaking-release or secret-change guard. Runs in the `docs` environment.
# Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... VERSION_ID=<id> REASON=... ACTOR=... scripts/docs/rollback.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}" "${VERSION_ID:?}" "${REASON:?}" "${ACTOR:?}"
[[ "$VERSION_ID" =~ ^[0-9a-f-]{36}$ ]] || die "invalid version_id"
msg="rollback by $ACTOR: $REASON"
# wrangler caps the rollback message at 120 characters.
[ "${#msg}" -le 120 ] || die "keep '$(printf 'rollback by %s: ' "$ACTOR")<reason>' within 120 characters (now ${#msg})"

# The target must be a version of the docs Worker. A CI deploy's message is its commit, so
# /version.json can confirm it after the rollback; the manual first deploy has none.
view="$(docs_wrangler versions view "$VERSION_ID" --name "$DOCS_WORKER" --json | json_tail)" ||
  die "no version $VERSION_ID of $DOCS_WORKER"
commit="$(jq -r '.annotations["workers/message"] // empty' <<<"$view")"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || commit=""

only() { [ "$(docs_wrangler deployments status --name "$DOCS_WORKER" --json | json_tail |
  jq -c '[.versions[] | [.version_id, .percentage]]')" = "[[\"$1\",100]]" ]; }
docs_wrangler rollback "$VERSION_ID" --name "$DOCS_WORKER" -m "$msg" -y >&2
for _ in $(seq 1 24); do only "$VERSION_ID" && break; sleep 5; done
only "$VERSION_ID" || die "the deployment isn't $VERSION_ID alone at 100% after the rollback"
expect_site "https://$DOCS_HOST" "$commit" || die "https://$DOCS_HOST doesn't serve the target after the rollback"
echo "### Docs rolled back to $VERSION_ID${commit:+ (${commit::7})}" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
