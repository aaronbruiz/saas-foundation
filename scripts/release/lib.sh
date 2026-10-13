#!/usr/bin/env bash
# Shared helpers for production releases and rollbacks (ADR-0029). Sourced by the scripts next to
# it; release.yml and rollback.yml run them from `main`'s checkout in environment `production`.
# Each step passes only the credential it needs: CLOUDFLARE_API_TOKEN (Workers Editor on the
# production Worker only) or NEON_API_KEY (production Neon project), never both to one step.
# Requires: curl, jq, pnpm (wrangler and node from the workspace).
set -euo pipefail
# A failure inside `$(…)` stops the script too (bash turns errexit off there by default).
shopt -s inherit_errexit

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$ROOT/apps/web/wrangler.jsonc"
log() { echo "[release] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# The production Worker's name, account and hostname, from `main`'s wrangler.jsonc.
WORKER="$(grep -m1 -oE '^  "name": *"[a-z0-9-]+"' "$CONFIG" | grep -oE '"[a-z0-9-]+"$' | tr -d '"' || true)"
ACCOUNT="$(grep -m1 -oE '"account_id": *"[0-9a-f]{32}"' "$CONFIG" | grep -oE '[0-9a-f]{32}' || true)"
APP_HOST="$(grep -m1 -oE '"pattern": *"[a-z0-9.-]+"' "$CONFIG" | grep -oE '"[a-z0-9.-]+"$' | tr -d '"' || true)"
PROD_HYPERDRIVE_ID="$(grep -m1 -oE '"id": *"[0-9a-f]{32}"' "$CONFIG" | grep -oE '[0-9a-f]{32}' || true)"
[ -n "$WORKER" ] && [ -n "$ACCOUNT" ] && [ -n "$APP_HOST" ] && [ -n "$PROD_HYPERDRIVE_ID" ] ||
  die "can't read the Worker name, account, hostname or Hyperdrive id from apps/web/wrangler.jsonc"

wrangler() { CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" pnpm --dir "$ROOT/apps/web" exec wrangler "$@"; }

# `wrangler … --json` may print notices before the JSON; keep from the first `{` or `[` line.
json_tail() { sed -n '/^[[{]/,$p'; }

# The live deployment: `{ versions: [{ version_id, percentage }] }`.
deployment() { wrangler deployments status --name "$WORKER" --json | json_tail; }

# Version annotations (`workers/tag`, `workers/message`) of version id $1.
annotations() { wrangler versions view "$1" --name "$WORKER" --json | json_tail | jq -c '.annotations // {}'; }

# The newest 10 versions with metadata and annotations (JSON array).
versions_list() {
  local v
  v="$(wrangler versions list --name "$WORKER" --json | json_tail)"
  jq -e 'type == "array" and length > 0' <<<"$v" >/dev/null || die "couldn't list versions"
  printf '%s' "$v"
}

# The version whose code version $1 runs: itself, or for a `wrangler secret put` version (annotated
# `workers/triggered_by: secret`, which carries no tag or message), the newest non-secret version
# created before it. Empty if that's outside the listed versions ($2 = versions_list).
code_version() {
  jq -r --arg v "$1" '
    (map(select(.id == $v)) | first) as $me
    | if $me == null then empty
      elif ($me.annotations["workers/triggered_by"] // "") != "secret" then $me.id
      else [.[] | select(.metadata.created_on < $me.metadata.created_on
              and (.annotations["workers/triggered_by"] // "") != "secret")]
           | sort_by(.metadata.created_on) | last | .id // empty
      end' <<<"$2"
}

# `build=<id>` from a version message `commit=<sha> build=<id>` (ADR-0029 decision 4).
message_field() { # $1 = message, $2 = field
  sed -nE "s/(^|.* )$2=([^ ]+).*/\2/p" <<<"$1"
}

# GET https://$APP_HOST/api/health, optionally through the version override header (ADR-0029
# decision 3, step 6), until it reports ok, db up, version $1 and build $2. Retries for ~2 min:
# a new deployment takes a moment to reach every location.
expect_health() { # $1 = version, $2 = build id, $3 = version id to override to (optional)
  local hdr=() body
  [ -n "${3:-}" ] && hdr=(-H "Cloudflare-Workers-Version-Overrides: $WORKER=\"$3\"")
  for _ in $(seq 1 24); do
    body="$(curl -sS -m 15 "${hdr[@]}" "https://$APP_HOST/api/health" || true)"
    if jq -e --arg v "$1" --arg b "$2" \
      '.ok == true and .db == "up" and .version == $v and .build == $b' <<<"$body" >/dev/null 2>&1; then
      log "health OK${3:+ (override $3)}: $body"
      return 0
    fi
    sleep 5
  done
  log "health not as expected${3:+ (override $3)}: wanted version $1 build $2, got: ${body:-no response}"
  return 1
}

# Neon REST API for the production project (no CLI). $1 = path under /projects/:id, rest = curl
# args. Retries while another operation holds the branch (HTTP 423). Prints the body on 2xx.
neon_api() {
  : "${NEON_API_KEY:?}" "${NEON_PROJECT_ID:?}"
  local path="$1"; shift
  local out code body
  for _ in $(seq 1 30); do
    out="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $NEON_API_KEY" \
      -H 'Content-Type: application/json' -H 'Accept: application/json' \
      "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID$path" "$@")" || die "Neon API $path: no response"
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    [ "$code" = 423 ] || break
    sleep 3
  done
  [[ "$code" =~ ^2[0-9][0-9]$ ]] || die "Neon API $path -> HTTP $code: $(jq -c '.message // .' <<<"$body" 2>/dev/null)"
  printf '%s' "$body"
}

neon_main_id() { neon_api /branches | jq -r '[.branches[] | select(.name == "main") | .id][0] // empty'; }

# Sets DB_URL to production `main`'s direct (non-pooler) connection URI and masks it in CI. Call it
# at a script's top level (not inside `$(…)`: the mask command must reach the runner's stdout).
# Never print DB_URL.
load_prod_db_url() {
  local id
  id="$(neon_main_id)"
  [ -n "$id" ] || die "no Neon branch named main"
  DB_URL="$(neon_api "/connection_uri?branch_id=$id&database_name=${NEON_DATABASE:-app}&role_name=${NEON_ROLE:-app_owner}&pooled=false" | jq -r .uri)"
  [ -n "$DB_URL" ] && [ "$DB_URL" != null ] || die "no connection URI for main"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$DB_URL"; fi
}

# Migrations production has applied: JSON array of { hash, created_at } (drizzle's bookkeeping).
applied_migrations() { DATABASE_URL="${DB_URL:?load_prod_db_url first}" node "$ROOT/packages/db/scripts/applied.mjs"; }

# Lines of $1 into the array named $2; an empty string gives an empty array. Results are captured
# with `$(…)` first (set -e stops on a failure) and never read through `< <(…)`, which would hide
# one and let a guard pass.
lines_to() { local -n arr="$2"; arr=(); [ -z "$1" ] || mapfile -t arr <<<"$1"; }

# Pending: journal entries of folder $1 not yet applied (`when` not among the `created_at` values of
# applied JSON $2). Prints the contract migrations among them (scripts/contract-migrations.sh).
unapplied_contracts() { # $1 = migrations folder, $2 = applied JSON
  local tags=() files=() t out
  out="$(jq -r --argjson a "$2" '($a | map(.created_at)) as $done
    | .entries[] | select(.when as $w | $done | index($w) | not) | .tag' "$1/meta/_journal.json")"
  lines_to "$out" tags
  for t in "${tags[@]}"; do
    [ -f "$1/$t.sql" ] || die "journal entry $t has no $t.sql"
    files+=("$1/$t.sql")
  done
  ((${#files[@]})) || return 0
  "$ROOT/scripts/contract-migrations.sh" "${files[@]}"
}

# Rollback guard (ADR-0029 decision 6): applied migrations (JSON $1) that the target's journal ($2)
# lacks, looked up in `main`'s migrations folder ($3). Prints the contract migrations among them,
# and `unknown:<created_at>` for an applied migration `main` doesn't know (treated as breaking).
applied_contracts_missing_from() { # $1 = applied JSON, $2 = target _journal.json, $3 = main's folder
  local whens=() files=() w tag out
  out="$(jq -r --slurpfile j "$2" '($j[0].entries | map(.when)) as $have
    | .[] | select(.created_at as $c | $have | index($c) | not) | .created_at' <<<"$1")"
  lines_to "$out" whens
  for w in "${whens[@]}"; do
    tag="$(jq -r --argjson w "$w" '[.entries[] | select(.when == $w) | .tag][0] // empty' "$3/meta/_journal.json")"
    if [ -n "$tag" ] && [ -f "$3/$tag.sql" ]; then files+=("$3/$tag.sql"); else echo "unknown:$w"; fi
  done
  ((${#files[@]})) || return 0
  "$ROOT/scripts/contract-migrations.sh" "${files[@]}"
}
