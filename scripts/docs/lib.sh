#!/usr/bin/env bash
# Shared helpers for the docs Worker's deploys (ADR-0028, ADR-0029 decisions 5–6). Sourced by the
# scripts next to it; the docs workflows run them from `main`'s checkout with one per-Worker token
# as CLOUDFLARE_API_TOKEN. The docs site has no bindings, secrets or data: the build output (`dist`)
# is the whole deploy, and it's always treated as data.
# Requires: curl, jq, pnpm (wrangler from the workspace).
set -euo pipefail
# A failure inside `$(…)` stops the script too (bash turns errexit off there by default).
shopt -s inherit_errexit

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log() { echo "[docs] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# The docs Worker's name and hostname, from `main`'s apps/docs/wrangler.jsonc (check-bindings.mjs
# keeps it assets-only).
DOCS_CONFIG="$ROOT/apps/docs/wrangler.jsonc"
DOCS_WORKER="$(grep -m1 -oE '^  "name": *"[a-z0-9-]+"' "$DOCS_CONFIG" | grep -oE '"[a-z0-9-]+"$' | tr -d '"' || true)"
DOCS_HOST="$(grep -m1 -oE '"pattern": *"[a-z0-9.-]+"' "$DOCS_CONFIG" | grep -oE '"[a-z0-9.-]+"$' | tr -d '"' || true)"
[ -n "$DOCS_WORKER" ] && [ -n "$DOCS_HOST" ] ||
  die "can't read the Worker name or hostname from apps/docs/wrangler.jsonc"

# The docs config has no account id: wrangler takes CLOUDFLARE_ACCOUNT_ID, which must be the one
# pinned in apps/web/wrangler.jsonc (ADR-0017, as scripts/preview/lib.sh checks).
pinned_account="$(grep -oE '"account_id": *"[0-9a-f]{32}"' "$ROOT/apps/web/wrangler.jsonc" | grep -oE '[0-9a-f]{32}' || true)"
[ -n "$pinned_account" ] && [ "${CLOUDFLARE_ACCOUNT_ID:-}" = "$pinned_account" ] ||
  die "CLOUDFLARE_ACCOUNT_ID doesn't match account_id pinned in apps/web/wrangler.jsonc"

docs_wrangler() { pnpm --dir "$ROOT/apps/docs" exec wrangler "$@"; }

# `wrangler … --json` may print notices before the JSON; keep from the first `{` or `[` line.
json_tail() { sed -n '/^[[{]/,$p'; }

# The build output (resolved directory $1) is untrusted data (ADR-0028 "Preview isolation"): plain
# files only, no env files, no Wrangler config or state, and the files the site promises.
check_dist() {
  [ -z "$(find "$1" -type l -print -quit)" ] || die "the site contains symlinks"
  [ -z "$(find "$1" \( -name '.dev.vars*' -o -name '.env*' -o -name 'wrangler.json' \
    -o -name 'wrangler.jsonc' -o -name 'wrangler.toml' -o -name '.wrangler' \) -print -quit)" ] ||
    die "the site contains .dev.vars/.env files or Wrangler config"
  local f
  for f in index.html 404.html llms.txt index.md _headers; do
    [ -s "$1/$f" ] || die "the site has no $f"
  done
}

# A Wrangler config for a deploy of the site in $1 (absolute), written to $2: the assets-only keys
# of `main`'s apps/docs/wrangler.jsonc, with the assets directory pointing at $1. `--preview` drops
# the routes and adds the empty `previews` block that `wrangler preview` requires (the committed
# config may not have one, check-bindings.mjs). The file sits in its own directory, so wrangler
# finds no .env or .dev.vars next to it.
write_config() { # $1 = site dir, $2 = output file, $3 = --preview (optional)
  node "$ROOT/scripts/docs/config.mjs" "$DOCS_CONFIG" "$1" ${3:-} >"$2"
}

# Until $1 (a base URL) serves the site: `/`, `/llms.txt` and `/index.md` (as text/markdown), and,
# if $2 is set, `/version.json` reporting commit $2. Retries for ~2 min: a new deployment takes a
# moment to reach every location.
expect_site() { # $1 = base URL, $2 = commit (optional)
  local ok body
  for _ in $(seq 1 24); do
    ok=1
    curl -fsS -m 15 -o /dev/null "$1/" || ok=0
    curl -fsS -m 15 "$1/llms.txt" 2>/dev/null | grep -q '^# ' || ok=0
    [[ "$(curl -fsS -m 15 -o /dev/null -w '%{content_type}' "$1/index.md" 2>/dev/null)" == text/markdown* ]] || ok=0
    if [ -n "${2:-}" ]; then
      body="$(curl -fsS -m 15 "$1/version.json" 2>/dev/null || true)"
      jq -e --arg c "$2" '.commit == $c' <<<"$body" >/dev/null 2>&1 || ok=0
    fi
    if [ "$ok" = 1 ]; then log "site OK: $1${2:+ (commit $2)}"; return 0; fi
    sleep 5
  done
  log "site not as expected at $1${2:+ (wanted commit $2, version.json: ${body:-none})}"
  return 1
}
