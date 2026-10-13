#!/usr/bin/env bash
# ADR-0029 decision 3, step 8: `versions upload` doesn't apply routes, custom domains or cron
# triggers. Compares `routes` and `triggers` in apps/web/wrangler.jsonc between $TAG and $PREV_TAG;
# if they differ (or can't be read), the release stops before promotion and the owner applies them
# by hand. Output (GITHUB_OUTPUT): routes_changed=true|false. Needs the tags fetched.
# Usage: TAG=web-vX.Y.Z [PREV_TAG=web-vA.B.C] scripts/release/routes-changed.sh
set -euo pipefail
: "${TAG:?}"
out() { echo "routes_changed=$1" >>"${GITHUB_OUTPUT:-/dev/null}"; echo "[release] routes/triggers changed: $1" >&2; }
[ -n "${PREV_TAG:-}" ] || { out false; exit 0; } # first release: nothing to compare with
# Full-line `//` comments and trailing commas are all the JSONC this file uses; anything else fails
# to parse, which counts as changed (fail closed).
pick='const s=require("fs").readFileSync(0,"utf8").replace(/^\s*\/\/.*$/gm,"").replace(/,(\s*[}\]])/g,"$1");
const c=JSON.parse(s);process.stdout.write(JSON.stringify({routes:c.routes??null,triggers:c.triggers??null}))'
a="$(git show "$PREV_TAG:apps/web/wrangler.jsonc" | node -e "$pick" 2>/dev/null)" || { out true; exit 0; }
b="$(git show "$TAG:apps/web/wrangler.jsonc" | node -e "$pick" 2>/dev/null)" || { out true; exit 0; }
if [ "$a" = "$b" ]; then out false; else out true; fi
