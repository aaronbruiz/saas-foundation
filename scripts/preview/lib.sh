#!/usr/bin/env bash
# Shared helpers for per-PR previews (ADR-0011). Sourced by up.sh / deploy-artifact.sh / down.sh /
# janitor.sh.
# Requires: pnpm, jq, curl. Credentials come from the environment (GitHub Actions secrets/vars).
set -euo pipefail

: "${NEON_API_KEY:?}" "${NEON_PREVIEW_PROJECT_ID:?}" "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
NEON_DATABASE="${NEON_DATABASE:-app}"
NEON_ROLE="${NEON_ROLE:-app_owner}"
NEON_PREVIEW_PARENT_BRANCH="${NEON_PREVIEW_PARENT_BRANCH:-preview-seed}"
# Neon Free: 10 branches per project; the preview project's own seed branch uses one.
NEON_MAX_BRANCHES="${NEON_MAX_BRANCHES:-10}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# ADR-0013: PR previews live on their own Worker, never as versions of the production Worker.
PREVIEW_WORKER="${PREVIEW_WORKER:-saas-foundation-preview}"

# Fail closed (ADR-0017): the account in CI must be the one pinned in wrangler.jsonc, so direct API
# calls (Hyperdrive list/delete) can't target another account the token reaches.
pinned_account="$(grep -oE '"account_id": *"[0-9a-f]{32}"' "$ROOT/apps/web/wrangler.jsonc" | grep -oE '[0-9a-f]{32}' || true)"
if [ -z "$pinned_account" ] || [ "$pinned_account" != "$CLOUDFLARE_ACCOUNT_ID" ]; then
  echo "[preview] ERROR: CLOUDFLARE_ACCOUNT_ID doesn't match account_id pinned in apps/web/wrangler.jsonc" >&2
  exit 1
fi

names_for() { # $1 = PR number
  PREVIEW_NAME="pr-$1"
  NEON_BRANCH="preview/pr-$1"
  HYPERDRIVE_NAME="saas-pr-$1"
}

neon() { pnpm --dir "$ROOT" exec neonctl --api-key "$NEON_API_KEY" "$@"; }
wrangler() { pnpm --dir "$ROOT/apps/web" exec wrangler "$@"; }

# $1 = path under /accounts/:id, rest = curl args. Prints the body on 2xx; otherwise returns 1 and
# leaves the HTTP status in CF_HTTP_CODE (000 = no response). Checked explicitly, so it also fails
# correctly where `set -e` is off.
cf_api() {
  local path="$1"; shift
  local out code body
  CF_HTTP_CODE=000
  if ! out="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID$path" "$@")"; then
    log "ERROR: Cloudflare API $path: no response"
    return 1
  fi
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  CF_HTTP_CODE="$code"
  if ! [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    log "ERROR: Cloudflare API $path -> HTTP $code: $(printf '%s' "$body" | jq -c '.errors' 2>/dev/null)"
    return 1
  fi
  printf '%s' "$body"
}

# Legacy per-PR Hyperdrive configs (ADR-0011), listed only if the token may: prints their names, or
# nothing with the narrow per-Worker token (401/403). Any other failure is an error.
legacy_hyperdrive_json() {
  local out
  if out="$(cf_api /hyperdrive/configs 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
  if [ "$CF_HTTP_CODE" = 401 ] || [ "$CF_HTTP_CODE" = 403 ]; then
    log "no Hyperdrive access (per-Worker token): skipping legacy per-PR Hyperdrive cleanup"
    printf '{"result":[]}'
    return 0
  fi
  log "ERROR: listing Hyperdrive configs failed (HTTP $CF_HTTP_CODE)"
  return 1
}

# Preflight: say which kind of token CLOUDFLARE_API_TOKEN is and whether it's active, without
# printing it. User tokens verify at /user/tokens/verify, account-owned tokens at
# /accounts/:id/tokens/verify.
cf_token_preflight() {
  local user acct
  user="$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    https://api.cloudflare.com/client/v4/user/tokens/verify | jq -r '.result.status // ("invalid: " + (.errors|tostring))')"
  acct="$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify" | jq -r '.result.status // ("invalid: " + (.errors|tostring))')"
  log "Cloudflare token check: as user token -> $user; as account-owned token for $CLOUDFLARE_ACCOUNT_ID -> $acct"
  if [ "$user" != active ] && [ "$acct" != active ]; then
    # Not an API token (e.g. a local `wrangler auth token` OAuth session for a manual run): the
    # Worker check below decides.
    log "not a verifiable API token; checking it can read $PREVIEW_WORKER"
  fi
  # ADR-0019: a per-Worker token can't create Workers, and `wrangler preview` would try to when the
  # parent is missing. Worker-scoped read, so the narrow CI token can do it.
  if ! cf_api "/workers/workers/$PREVIEW_WORKER" >/dev/null 2>&1; then
    log "ERROR: can't read Worker $PREVIEW_WORKER: the token is wrong/inactive, or the Worker doesn't exist (an admin creates it once)"
    return 1
  fi
}

# The account's workers.dev subdomain: the CI variable (the narrow token can't read account
# settings), or the API for manual runs with a broader token.
workers_subdomain() {
  if [ -n "${CLOUDFLARE_WORKERS_SUBDOMAIN:-}" ]; then echo "$CLOUDFLARE_WORKERS_SUBDOMAIN"
  else cf_api /workers/subdomain | jq -r '.result.subdomain'; fi
}

# Deletes the Worker Preview `$1` and checks its URL stopped serving. Returns 2 if it still serves
# (Previews beta issue): callers keep its data resources quarantined then. Exits on real errors.
delete_preview_verified() {
  local name="$1" out url status=""
  if ! out="$(wrangler preview delete --worker-name "$PREVIEW_WORKER" --name "$name" --skip-confirmation 2>&1)"; then
    if printf '%s' "$out" | grep -q 'Preview not found'; then
      log "no preview $name (already deleted)"
    else
      printf '%s\n' "$out" >&2
      log "ERROR: deleting preview $name failed"
      exit 1
    fi
  fi
  local sub
  sub="$(workers_subdomain)" && [ -n "$sub" ] && [ "$sub" != null ] ||
    { log "ERROR: no workers.dev subdomain (set CLOUDFLARE_WORKERS_SUBDOMAIN)"; exit 1; }
  url="https://${name}-${PREVIEW_WORKER}.${sub}.workers.dev"
  for _ in 1 2 3 4 5 6; do
    status="$(curl -s -o /dev/null -w '%{http_code}' "$url/api/health" || true)"
    [ "$status" = 404 ] && break
    sleep 5
  done
  if [ "$status" = 404 ]; then
    log "verified: $url returns 404"
    return 0
  fi
  log "WARN: $url still returns $status after delete (Cloudflare Previews beta issue)"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning title=Preview URL still serving::$url returned $status after wrangler preview delete"
  return 2
}

# ---- Preview slots (ADR-0019) ----------------------------------------------------------------
# Slot n = Neon branch `preview/slot-n` (renamed `preview/slot-n/pr-<PR>` while claimed, or
# `preview/slot-n/quarantine-pr-<PR>` while an old preview URL still serves) + the Hyperdrive config
# at position n of PREVIEW_HYPERDRIVE_SLOTS. Created by provision-slots.sh (admin), never by CI.

load_slots() {
  : "${PREVIEW_HYPERDRIVE_SLOTS:?set by scripts/preview/provision-slots.sh (CI variable)}"
  IFS=, read -ra SLOT_IDS <<<"$PREVIEW_HYPERDRIVE_SLOTS"
  local i
  for i in "${SLOT_IDS[@]}"; do
    [[ "$i" =~ ^[0-9a-f]{32}$ ]] || { log "ERROR: PREVIEW_HYPERDRIVE_SLOTS must be comma-separated Hyperdrive ids"; exit 1; }
  done
}

# [{id, name, slot}] for every slot branch.
slot_branches() {
  neon_branches_json | jq -c '[.[] | select(.name | test("^preview/slot-[0-9]+(/|$)"))
    | {id, name, slot: (.name | capture("^preview/slot-(?<n>[0-9]+)").n | tonumber)}]'
}

# True only if GitHub says PR $1 is closed or merged, asked for that PR right now. Any error or
# other answer counts as open (fail closed: never free a slot an open PR might hold).
pr_is_closed() {
  local state
  state="$(gh pr view "$1" --json state --jq .state 2>/dev/null)" || return 1
  [ "$state" = CLOSED ] || [ "$state" = MERGED ]
}

# Frees slot $1 (branch id $2) held by PR $3: wipe its data first, then delete the preview.
# Returns 0 released, 2 quarantined (the old URL still serves, and its binding reaches this slot),
# 1 on any failure, leaving the slot claimed so nothing reuses it. Every step is checked
# explicitly: callers may run it in a condition, where `set -e` doesn't apply.
release_slot() {
  local slot="$1" id="$2" pr="$3" rc=0
  log "releasing slot $slot (PR #$pr)"
  if ! neon branches reset "$id" --parent --project-id "$NEON_PREVIEW_PROJECT_ID" --output json >/dev/null; then
    log "ERROR: resetting slot $slot failed; it stays claimed"
    return 1
  fi
  delete_preview_verified "pr-$pr" || rc=$?
  local name="preview/slot-$slot"
  [ "$rc" = 2 ] && name="preview/slot-$slot/quarantine-pr-$pr"
  [ "$rc" = 0 ] || [ "$rc" = 2 ] || { log "ERROR: deleting pr-$pr's preview failed; slot $slot stays claimed"; return 1; }
  if ! neon branches rename "$id" "$name" --project-id "$NEON_PREVIEW_PROJECT_ID" --output json >/dev/null; then
    log "ERROR: renaming slot $slot failed; it stays claimed"
    return 1
  fi
  [ "$rc" = 2 ] && log "slot $slot quarantined until pr-$pr's URL stops serving (the janitor re-checks)"
  return "$rc"
}

# The slot PR $1 holds, claiming one if needed (starting at PR mod slots, so PRs spread out). Slots
# held by PRs that are no longer open are released on the way. Sets SLOT, SLOT_BRANCH_ID, HD_ID.
claim_slot() {
  local pr="$1" all mine count i k entry name id holder rc
  load_slots
  count=${#SLOT_IDS[@]}
  SLOT=""
  for _ in 1 2 3; do
    all="$(slot_branches)"
    mine="$(jq -r --arg s "/pr-$pr" '[.[] | select(.name | endswith($s)) | select(.name | test("/quarantine-") | not)][0] // empty | "\(.slot) \(.id)"' <<<"$all")"
    if [ -n "$mine" ]; then read -r SLOT SLOT_BRANCH_ID <<<"$mine"; break; fi
    for i in $(seq 0 $((count - 1))); do
      k=$(((pr + i) % count + 1))
      entry="$(jq -c --argjson k "$k" '[.[] | select(.slot == $k)][0] // empty' <<<"$all")"
      [ -n "$entry" ] || continue # not provisioned
      name="$(jq -r .name <<<"$entry")"
      id="$(jq -r .id <<<"$entry")"
      case "$name" in
        "preview/slot-$k") ;;
        "preview/slot-$k/pr-"*)
          holder="${name##*/pr-}"
          pr_is_closed "$holder" || continue
          rc=0
          release_slot "$k" "$id" "$holder" || rc=$?
          [ "$rc" = 0 ] || continue
          ;;
        *) continue ;; # quarantined
      esac
      neon branches rename "$id" "preview/slot-$k/pr-$pr" --project-id "$NEON_PREVIEW_PROJECT_ID" --output json >/dev/null
      # Claims aren't atomic (ADR-0019): re-read after a moment; a concurrent claimer wins or loses here.
      sleep 3
      if [ "$(neon_branches_json | jq -r --arg id "$id" '.[] | select(.id == $id) | .name')" = "preview/slot-$k/pr-$pr" ]; then
        SLOT="$k"
        SLOT_BRANCH_ID="$id"
        log "claimed slot $k for PR #$pr"
        break 2
      fi
      log "lost slot $k to a concurrent claim; retrying"
      break
    done
  done
  [ -n "$SLOT" ] || { log "ERROR: no free preview slot ($count slots; close PRs or wait for quarantined slots)"; exit 1; }
  [ "$SLOT" -le "$count" ] || { log "ERROR: slot $SLOT has no Hyperdrive id in PREVIEW_HYPERDRIVE_SLOTS"; exit 1; }
  HD_ID="${SLOT_IDS[$((SLOT - 1))]}"
}

# Resets the claimed slot's branch to the seed (fresh synthetic data on every deploy) and sets DB_URL
# (direct host; masked, never printed). Neon keeps the endpoint on reset, so the slot's Hyperdrive
# config stays valid.
reset_slot_db() {
  log "resetting slot $SLOT to $NEON_PREVIEW_PARENT_BRANCH"
  neon branches reset "$SLOT_BRANCH_ID" --parent --project-id "$NEON_PREVIEW_PROJECT_ID" --output json >/dev/null
  DB_URL="$(neon connection-string "$SLOT_BRANCH_ID" --project-id "$NEON_PREVIEW_PROJECT_ID" \
    --database-name "$NEON_DATABASE" --role-name "$NEON_ROLE")"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$DB_URL"
  return 0
}

neon_branches_json() {
  neon branches list --project-id "$NEON_PREVIEW_PROJECT_ID" --output json |
    jq 'if type == "array" then . else .branches end'
}

neon_branch_exists() { neon_branches_json | jq -e --arg n "$1" 'any(.name == $n)' >/dev/null; }

hyperdrive_id_by_name() {
  cf_api /hyperdrive/configs | jq -r --arg n "$1" '.result[] | select(.name == $n) | .id' | head -n1
}

# Neon branch from preview-seed (synthetic data only), in the separate preview project. Sets DB_URL
# (direct, non-pooler: Hyperdrive does the pooling), masked in Actions and never printed.
ensure_preview_db() {
  if neon_branch_exists "$NEON_BRANCH"; then
    log "reusing Neon branch $NEON_BRANCH"
  else
    local count
    count="$(neon_branches_json | jq 'length')"
    if [ "$count" -ge "$NEON_MAX_BRANCHES" ]; then
      log "ERROR: preview slots exhausted ($count/$NEON_MAX_BRANCHES Neon branches). Close PRs or run the janitor."
      exit 1
    fi
    log "creating Neon branch $NEON_BRANCH from $NEON_PREVIEW_PARENT_BRANCH"
    neon branches create --project-id "$NEON_PREVIEW_PROJECT_ID" --name "$NEON_BRANCH" \
      --parent "$NEON_PREVIEW_PARENT_BRANCH" --output json >/dev/null
  fi
  DB_URL="$(neon connection-string "$NEON_BRANCH" --project-id "$NEON_PREVIEW_PROJECT_ID" \
    --database-name "$NEON_DATABASE" --role-name "$NEON_ROLE")"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$DB_URL"
  return 0
}

# Hyperdrive config for this PR, caching disabled (ADR-0004). Sets HD_ID.
ensure_hyperdrive() {
  HD_ID="$(hyperdrive_id_by_name "$HYPERDRIVE_NAME")"
  if [ -z "$HD_ID" ]; then
    log "creating Hyperdrive $HYPERDRIVE_NAME"
    wrangler hyperdrive create "$HYPERDRIVE_NAME" --connection-string="$DB_URL" --caching-disabled >/dev/null
    HD_ID="$(hyperdrive_id_by_name "$HYPERDRIVE_NAME")"
  fi
  [ -n "$HD_ID" ] || { log "ERROR: Hyperdrive $HYPERDRIVE_NAME not found after create"; exit 1; }
}

# Per-deploy preview auth secret (never stored; sessions reset on push). Sets AUTH_SECRET.
new_auth_secret() {
  AUTH_SECRET="$(openssl rand -base64 32)"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$AUTH_SECRET"
  return 0
}

# Deploy the preview on the preview Worker with its own auth settings, then smoke-test it.
# Args: extra `wrangler preview` args (e.g. --config). Needs AUTH_SECRET. Previews hold synthetic
# data only, so sign-up is open there (ADR-0014; production defaults to closed). The URL is
# deterministic, so Better Auth's origin checks match it.
# Output: in GitHub Actions writes `url=<preview URL>` to $GITHUB_OUTPUT; otherwise prints it.
deploy_preview() {
  local subdomain auth_url out url
  subdomain="$(workers_subdomain)"
  auth_url="https://${PREVIEW_NAME}-${PREVIEW_WORKER}.${subdomain}.workers.dev"
  # Global, not local: the EXIT trap runs after this function has returned.
  SECRETS_FILE="$(mktemp)"
  trap 'rm -f "$SECRETS_FILE"' EXIT
  chmod 600 "$SECRETS_FILE"
  printf 'BETTER_AUTH_SECRET=%s\n' "$AUTH_SECRET" >"$SECRETS_FILE"
  out="$(wrangler preview "$@" --worker-name "$PREVIEW_WORKER" --name "$PREVIEW_NAME" \
    --message "${GITHUB_SHA:-manual}" --json \
    --var "BETTER_AUTH_URL:$auth_url" --var "SIGNUP_MODE:open" --secrets-file "$SECRETS_FILE")"
  url="$(printf '%s' "$out" | node -e '
    const t = require("fs").readFileSync(0, "utf8"); const i = t.indexOf("{\n  \"preview\"");
    const d = JSON.parse(t.slice(i)); process.stdout.write(d.preview.urls[0]);')"
  # Defense in depth: only a plain workers.dev URL may leave this script.
  [[ "$url" =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$ ]] ||
    { log "ERROR: unexpected preview URL shape; refusing to output it"; exit 1; }

  # Smoke test: the preview reaches its own database through Hyperdrive.
  for _ in $(seq 1 10); do
    if curl -fsS "$url/api/health" | jq -e '.ok == true' >/dev/null; then
      log "health OK: $url/api/health"
      if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "url=$url" >>"$GITHUB_OUTPUT"; else echo "$url"; fi
      return 0
    fi
    sleep 3
  done
  log "ERROR: $url/api/health did not become healthy"
  exit 1
}

log() { echo "[preview] $*" >&2; }
