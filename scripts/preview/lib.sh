#!/usr/bin/env bash
# Shared helpers for per-PR previews (ADR-0021). Sourced by infra.sh (Hyperdrive + Neon side),
# deploy-artifact.sh, down.sh and janitor.sh (Worker side). Each CI job passes only its own
# Cloudflare token as CLOUDFLARE_API_TOKEN: no job holds both the Worker token and the Hyperdrive
# token.
# Requires: curl, jq (and pnpm only for deploy-artifact.sh). Credentials come from the environment.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
NEON_DATABASE="${NEON_DATABASE:-app}"
NEON_ROLE="${NEON_ROLE:-app_owner}"
NEON_PREVIEW_PARENT_BRANCH="${NEON_PREVIEW_PARENT_BRANCH:-preview-seed}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# ADR-0013: PR previews live on their own Worker, never as versions of the production Worker.
PREVIEW_WORKER="${PREVIEW_WORKER:-saas-foundation-preview}"

log() { echo "[preview] $*" >&2; }

# Fail closed (ADR-0017): the account in CI must be the one pinned in wrangler.jsonc, so direct API
# calls can't target another account the token reaches.
pinned_account="$(grep -oE '"account_id": *"[0-9a-f]{32}"' "$ROOT/apps/web/wrangler.jsonc" | grep -oE '[0-9a-f]{32}' || true)"
if [ -z "$pinned_account" ] || [ "$pinned_account" != "$CLOUDFLARE_ACCOUNT_ID" ]; then
  log "ERROR: CLOUDFLARE_ACCOUNT_ID doesn't match account_id pinned in apps/web/wrangler.jsonc"
  exit 1
fi
# The production Hyperdrive config (the first id in wrangler.jsonc; the previews sentinel is all
# zeros). Every preview path refuses it explicitly (ADR-0021).
PROD_HYPERDRIVE_ID="$(grep -oE '"id": *"[0-9a-f]{32}"' "$ROOT/apps/web/wrangler.jsonc" | head -n1 | grep -oE '[0-9a-f]{32}' || true)"
if ! [[ "$PROD_HYPERDRIVE_ID" =~ ^[0-9a-f]{32}$ ]] || [ "$PROD_HYPERDRIVE_ID" = "$(printf '0%.0s' {1..32})" ]; then
  log "ERROR: can't find the production Hyperdrive id in apps/web/wrangler.jsonc"
  exit 1
fi

# The only source of resource names (ADR-0021): a validated, numeric PR number.
names_for() { # $1 = PR number
  [[ "$1" =~ ^[1-9][0-9]{0,6}$ ]] || { log "ERROR: invalid PR number"; exit 1; }
  PREVIEW_NAME="pr-$1"
  NEON_BRANCH="preview/pr-$1"
  HYPERDRIVE_NAME="saas-pr-$1"
}

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

# Neon REST API for the preview project (no CLI: the privileged jobs install no packages).
# $1 = path under /projects/:id, rest = curl args. Retries while another operation holds the
# branch (HTTP 423), so never pass a request body on stdin. Prints the body on 2xx, else returns 1.
neon_api() {
  : "${NEON_API_KEY:?}" "${NEON_PREVIEW_PROJECT_ID:?}"
  local path="$1"; shift
  local out code body
  for _ in $(seq 1 30); do
    if ! out="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $NEON_API_KEY" \
      -H 'Content-Type: application/json' -H 'Accept: application/json' \
      "https://console.neon.tech/api/v2/projects/$NEON_PREVIEW_PROJECT_ID$path" "$@")"; then
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

# Id of the preview-project branch named $1 (empty if none). Fails if the listing fails.
neon_branch_id() {
  local list
  list="$(neon_api /branches)" || return 1
  jq -r --arg n "$1" '[.branches[] | select(.name == $n) | .id][0] // empty' <<<"$list"
}

# Direct (non-pooler: Hyperdrive pools) connection URI of branch id $1. Never print it.
neon_connection_uri() {
  neon_api "/connection_uri?branch_id=$1&database_name=$NEON_DATABASE&role_name=$NEON_ROLE&pooled=false" | jq -r .uri
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
    log "not a verifiable API token (e.g. a local OAuth session); the next API call decides"
  fi
}

# Worker-side preflight: the per-Worker token can't create Workers, and `wrangler preview` would try
# to when the parent is missing. Worker-scoped read, so the narrow token can do it.
cf_worker_preflight() {
  cf_token_preflight
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

# PR state, asked for that PR right now. Any error counts as "not that state" (fail closed: never
# deploy for a closed PR, never destroy an open PR's resources).
pr_state() { gh pr view "$1" --json state --jq .state 2>/dev/null; }
pr_is_closed() { local s; s="$(pr_state "$1")" || return 1; [ "$s" = CLOSED ] || [ "$s" = MERGED ]; }

# True if a preview.yml run for PR $1 (run name "Preview PR #N") hasn't completed. The janitor can't
# take the per-PR lock, so it skips such PRs until its next run. Fail closed: any listing error
# counts as active.
preview_run_active() {
  local runs active
  runs="$(gh run list --workflow preview.yml --limit 100 --json status,displayTitle 2>/dev/null)" || return 0
  active="$(jq -r --arg t "Preview PR #$1" 'any(.[]; .status != "completed" and .displayTitle == $t)' <<<"$runs" 2>/dev/null)" || return 0
  [ "$active" != false ]
}

# Deletes Worker Preview $1 through the Worker-scoped API (no wrangler needed). Idempotent. Its old
# deployments may keep executing afterwards (Cloudflare Previews beta, ADR-0021): that is not a
# release signal; deleting the PR's Hyperdrive config is what revokes database access.
delete_preview() {
  if cf_api "/workers/workers/$PREVIEW_WORKER/previews/$1" -X DELETE >/dev/null 2>&1; then
    log "deleted preview $1"
  elif [ "$CF_HTTP_CODE" = 404 ]; then
    log "no preview $1 (already deleted)"
  else
    log "ERROR: deleting preview $1 failed (HTTP $CF_HTTP_CODE)"
    return 1
  fi
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
  out="$(pnpm --dir "$ROOT/apps/web" exec wrangler preview "$@" --worker-name "$PREVIEW_WORKER" --name "$PREVIEW_NAME" \
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
