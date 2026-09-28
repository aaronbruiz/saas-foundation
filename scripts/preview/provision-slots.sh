#!/usr/bin/env bash
# Admin-only (ADR-0019): creates or repairs the preview slots. Each slot is a Neon branch
# `preview/slot-<n>` (child of preview-seed, in the preview project) plus a Hyperdrive config
# `saas-preview-slot-<n>` (caching disabled) pointing at that branch's endpoint. CI never runs this:
# it needs account-wide Hyperdrive access, which CI must not have. Idempotent; re-run it after
# rotating app_owner's password on preview-seed (it updates the configs' connection strings).
# Uses the admin's own logged-in `neonctl` and `wrangler` sessions.
# Usage: NEON_PREVIEW_PROJECT_ID=... [PREVIEW_SLOTS=6] scripts/preview/provision-slots.sh
# Output (stdout): the value for the CI variable PREVIEW_HYPERDRIVE_SLOTS (slot ids in order).
set -euo pipefail
: "${NEON_PREVIEW_PROJECT_ID:?}"
SLOTS="${PREVIEW_SLOTS:-6}"
# Neon Free: 10 branches per project; the seed takes one, and one stays free for maintenance.
[[ "$SLOTS" =~ ^[1-8]$ ]] || { echo "[slots] ERROR: PREVIEW_SLOTS must be 1-8" >&2; exit 1; }
NEON_DATABASE="${NEON_DATABASE:-app}"
NEON_ROLE="${NEON_ROLE:-app_owner}"
PARENT="${NEON_PREVIEW_PARENT_BRANCH:-preview-seed}"
PREVIEW_WORKER="${PREVIEW_WORKER:-saas-foundation-preview}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log() { echo "[slots] $*" >&2; }
neon() { pnpm --dir "$ROOT" exec neonctl "$@"; }
wrangler() { pnpm --dir "$ROOT/apps/web" exec wrangler "$@"; }

# Account pinned in the committed config (ADR-0017); the admin's wrangler session must reach it.
ACCOUNT="$(grep -oE '"account_id": *"[0-9a-f]{32}"' "$ROOT/apps/web/wrangler.jsonc" | grep -oE '[0-9a-f]{32}')"
CF_TOKEN="$(wrangler auth token 2>/dev/null | tail -1)"
cf() { curl -fsS -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT$1"; }

# The per-Worker CI token can't create Workers (ADR-0019): the preview Worker must exist.
cf "/workers/workers/$PREVIEW_WORKER" >/dev/null ||
  { log "ERROR: Worker $PREVIEW_WORKER doesn't exist in the account; create it first (an admin preview deploy does)"; exit 1; }

branches() { neon branches list --project-id "$NEON_PREVIEW_PROJECT_ID" --output json | jq 'if type == "array" then . else .branches end'; }
hd_json() { cf /hyperdrive/configs | jq '.result'; }

ids=()
for n in $(seq 1 "$SLOTS"); do
  # A slot's branch keeps its id when claimed (renamed to preview/slot-n/...), so match the prefix.
  id="$(branches | jq -r --arg n "$n" '[.[] | select(.name | test("^preview/slot-" + $n + "(/|$)"))][0].id // empty')"
  if [ -z "$id" ]; then
    log "creating Neon branch preview/slot-$n from $PARENT"
    neon branches create --project-id "$NEON_PREVIEW_PROJECT_ID" --name "preview/slot-$n" --parent "$PARENT" --output json >/dev/null
    id="$(branches | jq -r --arg n "$n" '[.[] | select(.name == "preview/slot-" + $n)][0].id')"
  fi
  url="$(neon connection-string "$id" --project-id "$NEON_PREVIEW_PROJECT_ID" --database-name "$NEON_DATABASE" --role-name "$NEON_ROLE")"
  name="saas-preview-slot-$n"
  hd="$(hd_json | jq -r --arg n "$name" '[.[] | select(.name == $n)][0].id // empty')"
  if [ -z "$hd" ]; then
    log "creating Hyperdrive $name"
    wrangler hyperdrive create "$name" --connection-string="$url" --caching-disabled >/dev/null
    hd="$(hd_json | jq -r --arg n "$name" '[.[] | select(.name == $n)][0].id')"
  else
    log "updating Hyperdrive $name (connection string, caching off)"
    wrangler hyperdrive update "$hd" --connection-string="$url" --caching-disabled >/dev/null
  fi
  [[ "$hd" =~ ^[0-9a-f]{32}$ ]] || { log "ERROR: no id for $name"; exit 1; }
  ids+=("$hd")
done
unset url
(IFS=,; echo "${ids[*]}")
log "set it: gh variable set PREVIEW_HYPERDRIVE_SLOTS --body <the line above>"
