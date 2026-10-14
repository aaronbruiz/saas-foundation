#!/usr/bin/env bash
# Helpers shared by scripts/preview/lib.sh (ADR-0021) and scripts/release/lib.sh (ADR-0029). The
# sourcing library defines `log` and sets NEON_API_PROJECT to the one Neon project its jobs may
# touch (the preview project or the production project). Requires: curl, jq.
NEON_DATABASE="${NEON_DATABASE:-app}"
NEON_ROLE="${NEON_ROLE:-app_owner}"

# Neon REST API (no CLI: the privileged preview jobs install no packages). $1 = path under
# /projects/:id, rest = curl args. Retries while another operation holds the branch (HTTP 423), so
# never pass a request body on stdin. Prints the body on 2xx, else returns 1.
neon_api() {
  : "${NEON_API_KEY:?}" "${NEON_API_PROJECT:?}"
  local path="$1"; shift
  local out code body
  for _ in $(seq 1 30); do
    if ! out="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $NEON_API_KEY" \
      -H 'Content-Type: application/json' -H 'Accept: application/json' \
      "https://console.neon.tech/api/v2/projects/$NEON_API_PROJECT$path" "$@")"; then
      log "ERROR: Neon API $path: no response"
      return 1
    fi
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    [ "$code" = 423 ] || break
    sleep 3
  done
  if ! [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    log "ERROR: Neon API $path -> HTTP $code: $(printf '%s' "$body" | jq -c '.message // .' 2>/dev/null)"
    return 1
  fi
  printf '%s' "$body"
}

# Id of the branch named $1 (empty if none). Fails if the listing fails.
neon_branch_id() {
  local list
  list="$(neon_api /branches)" || return 1
  jq -r --arg n "$1" '[.branches[] | select(.name == $n) | .id][0] // empty' <<<"$list"
}

# Direct (non-pooler: Hyperdrive pools) connection URI of branch id $1. Never print it.
neon_connection_uri() {
  neon_api "/connection_uri?branch_id=$1&database_name=$NEON_DATABASE&role_name=$NEON_ROLE&pooled=false" | jq -r .uri
}

# A build artifact (resolved directory $1) is untrusted data: plain files only (a symlink could point
# the config or assets outside it), no env files (wrangler could read local vars/secrets from them
# next to the config), and it holds the Worker config and the migration journal.
check_artifact_files() {
  [ -z "$(find "$1" -type l -print -quit)" ] || { log "ERROR: artifact contains symlinks"; return 1; }
  [ -z "$(find "$1" \( -name '.dev.vars*' -o -name '.env*' \) -print -quit)" ] ||
    { log "ERROR: artifact contains .dev.vars/.env files"; return 1; }
  [ -f "$1/apps/web/dist/server/wrangler.json" ] || { log "ERROR: artifact has no apps/web/dist/server/wrangler.json"; return 1; }
  [ -f "$1/packages/db/drizzle/meta/_journal.json" ] || { log "ERROR: artifact has no packages/db/drizzle journal"; return 1; }
}
