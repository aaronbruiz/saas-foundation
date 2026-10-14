#!/usr/bin/env bash
# Static site PR preview (ADR-0028 decision 5, ADR-0033): deploys a PR's built site as Worker
# Preview `pr-N` of the site's preview Worker, without running any of the PR's code. Runs only in
# the site's preview environment, from the default branch's scripts, config and lockfile, with the
# token that is Workers Editor on that preview Worker only. The site is data: checked by check_dist,
# deployed with a config derived from `main`'s apps/$SITE/wrangler.jsonc (no bindings, nothing from
# the PR).
# Usage: SITE=docs PR_NUMBER=123 ARTIFACT_DIR=/path HEAD_SHA=<sha> GH_TOKEN=... scripts/sites/preview.sh
# Output: in GitHub Actions writes `url=<preview URL>` to $GITHUB_OUTPUT; otherwise prints it.
source "$(dirname "$0")/lib.sh"
require_account
: "${PR_NUMBER:?}" "${ARTIFACT_DIR:?}" "${HEAD_SHA:?}"
# The preview helpers (names_for, require_preview_worker, pr_state, workers_subdomain), pointed at
# the site's preview Worker.
PREVIEW_WORKER="$SITE_WORKER-preview"
source "$ROOT/scripts/preview/lib.sh"
names_for "$PR_NUMBER"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || die "HEAD_SHA must be a commit SHA"

site="$(cd "$ARTIFACT_DIR" && pwd -P)"
check_dist "$site"
require_preview_worker || exit 1

# Never (re)publish a closed PR's preview; an unknown state fails.
state="$(pr_state "$PR_NUMBER" || true)"
case "$state" in
  OPEN) ;;
  CLOSED | MERGED)
    log "Preview skipped: PR #$PR_NUMBER is already closed ($state)"
    echo "::notice title=Preview skipped::PR #$PR_NUMBER is already closed"
    exit 0
    ;;
  *) die "can't read PR #$PR_NUMBER's state; not deploying" ;;
esac

url="https://${PREVIEW_NAME}-${PREVIEW_WORKER}.$(workers_subdomain).workers.dev"
[[ "$url" =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$ ]] || die "unexpected preview URL shape"

dir="$(mktemp -d)"
write_config "$site" "$dir/wrangler.json" --preview
# --ignore-base-config: only this config applies, never the dashboard's Preview base config.
site_wrangler preview --config "$dir/wrangler.json" --ignore-base-config \
  --worker-name "$PREVIEW_WORKER" --name "$PREVIEW_NAME" --message "$HEAD_SHA" >&2
expect_site "$url" || die "the preview doesn't serve the site"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "url=$url" >>"$GITHUB_OUTPUT"; else echo "$url"; fi
