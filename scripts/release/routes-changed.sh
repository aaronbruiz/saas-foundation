#!/usr/bin/env bash
# ADR-0029 decision 3, step 8: `versions upload` doesn't apply routes, custom domains or cron
# triggers. Compares `routes` and `triggers` in apps/web/wrangler.jsonc between $TAG and $BASE_TAG,
# the release that's live now: that's the configuration transition the deploy performs (for a
# redeploy of an older tag too). If they differ, can't be read, or the live version has no release
# tag, the release stops before promotion and the owner applies them by hand.
# Output (GITHUB_OUTPUT): routes_changed=true|false. Needs the tags fetched.
# Usage: TAG=web-vX.Y.Z BASE_TAG=<live release tag, or empty> scripts/release/routes-changed.sh
set -euo pipefail
: "${TAG:?}"
out() { echo "routes_changed=$1" >>"${GITHUB_OUTPUT:-/dev/null}"; echo "[release] routes/triggers changed: $1${2:+ ($2)}" >&2; }
[ -n "${BASE_TAG:-}" ] || { out true "the live version has no release tag"; exit 0; }
# Full-line `//` comments and trailing commas are all the JSONC this file uses; anything else fails
# to parse, which counts as changed (fail closed).
pick='const s=require("fs").readFileSync(0,"utf8").replace(/^\s*\/\/.*$/gm,"").replace(/,(\s*[}\]])/g,"$1");
const c=JSON.parse(s);process.stdout.write(JSON.stringify({routes:c.routes??null,triggers:c.triggers??null}))'
a="$(git show "$BASE_TAG:apps/web/wrangler.jsonc" | node -e "$pick" 2>/dev/null)" || { out true "can't read $BASE_TAG"; exit 0; }
b="$(git show "$TAG:apps/web/wrangler.jsonc" | node -e "$pick" 2>/dev/null)" || { out true "can't read $TAG"; exit 0; }
if [ "$a" = "$b" ]; then out false; else out true; fi
