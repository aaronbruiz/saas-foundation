#!/usr/bin/env bash
# Posts or updates a preview's PR comment (preview.yml, static-preview.yml): the first comment whose
# body starts with MARKER is edited, otherwise a new one is posted. The caller validates what goes
# into BODY; PR_NUMBER and the marker are checked here.
# Usage: GH_TOKEN=… REPO=owner/name PR_NUMBER=<n> MARKER='<!-- … -->' BODY='…' scripts/preview/comment.sh
set -euo pipefail
: "${GH_TOKEN:?}" "${REPO:?}" "${PR_NUMBER:?}" "${MARKER:?}" "${BODY:?}"
[[ "$PR_NUMBER" =~ ^[1-9][0-9]{0,6}$ ]] || { echo "unexpected PR number" >&2; exit 1; }
[[ "$MARKER" =~ ^'<!-- '[a-z-]+' -->'$ ]] || { echo "unexpected marker" >&2; exit 1; }
[[ "$BODY" == "$MARKER"* ]] || { echo "the body must start with the marker" >&2; exit 1; }
id="$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
  --jq ".[] | select(.body | startswith(\"$MARKER\")) | .id" | head -n1)"
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$id" -f body="$BODY" >/dev/null
else
  gh api "repos/$REPO/issues/$PR_NUMBER/comments" -f body="$BODY" >/dev/null
fi
