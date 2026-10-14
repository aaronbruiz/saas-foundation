#!/usr/bin/env bash
# Shared helpers for the static sites' deploys (ADR-0028, ADR-0033 decision 9; ADR-0029 decisions
# 5–6). SITE names the site's app directory (`docs` or `site`); its Worker config is
# apps/$SITE/wrangler.jsonc,
# kept assets-only by check-bindings.mjs. Sourced by the scripts next to it; the static-site
# workflows run them from `main`'s checkout with one per-Worker token as CLOUDFLARE_API_TOKEN. A
# static site has no bindings, secrets or data: the build output (`dist`) is the whole deploy, and
# it's always treated as data.
# Requires: curl, jq, pnpm (wrangler from the site's workspace package).
set -euo pipefail
# A failure inside `$(…)` stops the script too (bash turns errexit off there by default).
shopt -s inherit_errexit

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log() { echo "[${SITE:-sites}] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# What differs per site: the files its build must contain (checked on every deploy, check_dist)
# and what its smoke test fetches (site_pages_ok).
case "${SITE:-}" in
  docs) REQUIRED_FILES=(index.html 404.html llms.txt index.md _headers) ;;
  site) REQUIRED_FILES=(index.html pricing/index.html 404.html robots.txt sitemap-index.xml _headers) ;;
  *) die "SITE must be a static site's app directory (docs or site), not '${SITE:-}'" ;;
esac

# The site Worker's name and hostname, from `main`'s apps/$SITE/wrangler.jsonc.
SITE_CONFIG="$ROOT/apps/$SITE/wrangler.jsonc"
SITE_WORKER="$(grep -m1 -oE '^  "name": *"[a-z0-9-]+"' "$SITE_CONFIG" | grep -oE '"[a-z0-9-]+"$' | tr -d '"' || true)"
SITE_HOST="$(grep -m1 -oE '"pattern": *"[a-z0-9.-]+"' "$SITE_CONFIG" | grep -oE '"[a-z0-9.-]+"$' | tr -d '"' || true)"
[ -n "$SITE_WORKER" ] && [ -n "$SITE_HOST" ] ||
  die "can't read the Worker name or hostname from apps/$SITE/wrangler.jsonc"

# The site configs have no account id: wrangler takes CLOUDFLARE_ACCOUNT_ID, which must be the one
# pinned in apps/app/wrangler.jsonc (ADR-0017, as scripts/preview/lib.sh checks). Every script that
# calls Cloudflare runs this first.
require_account() {
  local pinned
  pinned="$(grep -oE '"account_id": *"[0-9a-f]{32}"' "$ROOT/apps/app/wrangler.jsonc" | grep -oE '[0-9a-f]{32}' || true)"
  [ -n "$pinned" ] && [ "${CLOUDFLARE_ACCOUNT_ID:-}" = "$pinned" ] ||
    die "CLOUDFLARE_ACCOUNT_ID doesn't match account_id pinned in apps/app/wrangler.jsonc"
}

site_wrangler() { pnpm --dir "$ROOT/apps/$SITE" exec wrangler "$@"; }

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
  for f in "${REQUIRED_FILES[@]}"; do
    [ -s "$1/$f" ] || die "the site has no $f"
  done
}

# A Wrangler config for a deploy of the site in $1 (absolute), written to $2: the assets-only keys
# of `main`'s apps/$SITE/wrangler.jsonc, with the assets directory pointing at $1. `--preview` drops
# the routes and adds the empty `previews` block that `wrangler preview` requires (the committed
# config may not have one, check-bindings.mjs). The file sits in its own directory, so wrangler
# finds no .env or .dev.vars next to it.
write_config() { # $1 = site dir, $2 = output file, $3 = --preview (optional)
  node "$ROOT/scripts/sites/config.mjs" "$SITE_CONFIG" "$1" ${3:-} >"$2"
}

# Whether $1 (a base URL) serves the site's pages, checked once. Responses go into variables, not
# pipes: a reader that stops early would fail curl (pipefail).
site_pages_ok() {
  local body type
  curl -fsS -m 15 -o /dev/null "$1/" || return 1
  case "$SITE" in
    docs)
      body="$(curl -fsS -m 15 "$1/llms.txt" 2>/dev/null)" && [[ "$body" == "# "* ]] || return 1
      type="$(curl -fsS -m 15 -o /dev/null -w '%{content_type}' "$1/index.md" 2>/dev/null)" &&
        [[ "$type" == text/markdown* ]] || return 1
      ;;
    site)
      curl -fsS -m 15 -o /dev/null "$1/pricing/" || return 1
      body="$(curl -fsS -m 15 "$1/robots.txt" 2>/dev/null)" && [[ "$body" == *"Sitemap: "* ]] || return 1
      ;;
  esac
}

# Until $1 (a base URL) serves the site (site_pages_ok) and, if $2 is set, `/version.json` reports
# commit $2. Retries for ~2 min: a new deployment takes a moment to reach every location.
expect_site() { # $1 = base URL, $2 = commit (optional)
  local ok body=
  for _ in $(seq 1 24); do
    ok=1
    site_pages_ok "$1" || ok=0
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
