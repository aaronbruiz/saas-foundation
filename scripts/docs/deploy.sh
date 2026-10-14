#!/usr/bin/env bash
# Docs production deploy (ADR-0028 decision 6, ADR-0029 decision 5): uploads the built site as a
# version of the docs Worker tagged `docs-<sha7>` with the commit as its message, deploys it at
# 100% and smoke-tests the custom domain. `versions upload`/`deploy` never change routes or domains
# (the owner attached the domain once with `wrangler deploy`). Runs in the `docs` environment with
# the token that is Workers Editor on the docs Worker only.
# Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ARTIFACT_DIR=/path SHA=<commit> scripts/docs/deploy.sh
source "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?}" "${ARTIFACT_DIR:?}" "${SHA:?}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "SHA must be a commit SHA"

site="$(cd "$ARTIFACT_DIR" && pwd -P)"
check_dist "$site"
jq -e --arg c "$SHA" '.commit == $c' "$site/version.json" >/dev/null 2>&1 ||
  die "the site's version.json doesn't report commit $SHA"

dir="$(mktemp -d)"
write_config "$site" "$dir/wrangler.json"
out="$(mktemp)"
WRANGLER_OUTPUT_FILE_PATH="$out" docs_wrangler versions upload --config "$dir/wrangler.json" \
  --tag "docs-${SHA::7}" --message "$SHA" >&2
new="$(jq -r 'select(.type == "version-upload") | .version_id' "$out" | tail -n1)"
[[ "$new" =~ ^[0-9a-f-]{36}$ ]] || die "couldn't read the uploaded version id"
log "uploaded $new (docs-${SHA::7})"

docs_wrangler versions deploy "$new@100%" --name "$DOCS_WORKER" --message "docs ${SHA::7}" -y >&2
expect_site "https://$DOCS_HOST" "$SHA" || die "https://$DOCS_HOST doesn't serve $SHA after the deploy"
echo "### Docs deployed: ${SHA::7} (version $new)" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
