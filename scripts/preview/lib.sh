#!/usr/bin/env bash
# Shared helpers for per-PR previews (ADR-0011). Sourced by up.sh / down.sh / janitor.sh.
# Requires: pnpm, jq, curl. Credentials come from the environment (GitHub Actions secrets/vars).
set -euo pipefail

: "${NEON_API_KEY:?}" "${NEON_PREVIEW_PROJECT_ID:?}" "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
NEON_DATABASE="${NEON_DATABASE:-app}"
NEON_ROLE="${NEON_ROLE:-app_owner}"
NEON_PREVIEW_PARENT_BRANCH="${NEON_PREVIEW_PARENT_BRANCH:-preview-seed}"
# Neon Free: 10 branches per project; the preview project's own seed branch uses one.
NEON_MAX_BRANCHES="${NEON_MAX_BRANCHES:-10}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

names_for() { # $1 = PR number
  PREVIEW_NAME="pr-$1"
  NEON_BRANCH="preview/pr-$1"
  HYPERDRIVE_NAME="saas-pr-$1"
}

neon() { pnpm --dir "$ROOT" exec neonctl --api-key "$NEON_API_KEY" "$@"; }
wrangler() { pnpm --dir "$ROOT/apps/web" exec wrangler "$@"; }

cf_api() { # $1 = path under /accounts/:id, rest = curl args
  local path="$1"; shift
  curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID$path" "$@"
}

neon_branches_json() {
  neon branches list --project-id "$NEON_PREVIEW_PROJECT_ID" --output json |
    jq 'if type == "array" then . else .branches end'
}

neon_branch_exists() { neon_branches_json | jq -e --arg n "$1" 'any(.name == $n)' >/dev/null; }

hyperdrive_id_by_name() {
  cf_api /hyperdrive/configs | jq -r --arg n "$1" '.result[] | select(.name == $n) | .id' | head -n1
}

log() { echo "[preview] $*" >&2; }
