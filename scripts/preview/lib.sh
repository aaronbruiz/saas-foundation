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

cf_api() { # $1 = path under /accounts/:id, rest = curl args. Fails loudly with the API's reason.
  local path="$1"; shift
  local out code body
  out="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID$path" "$@")"
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if [ "$code" -ge 400 ]; then
    log "ERROR: Cloudflare API $path -> HTTP $code: $(printf '%s' "$body" | jq -c '.errors' 2>/dev/null)"
    [ "$code" = 403 ] && log "hint: CLOUDFLARE_API_TOKEN needs Account > Hyperdrive: Edit and Account > Workers Scripts: Edit for account $CLOUDFLARE_ACCOUNT_ID"
    return 1
  fi
  printf '%s' "$body"
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
    # Not an API token (e.g. a local `wrangler auth token` OAuth session for a manual run): accept
    # it only if it can actually read this account.
    if cf_api /workers/subdomain >/dev/null 2>&1; then
      log "not a verifiable API token, but it can read account $CLOUDFLARE_ACCOUNT_ID; continuing"
      return 0
    fi
    log "ERROR: CLOUDFLARE_API_TOKEN is not an active token (wrong/old secret value, expired, or a different account)"
    return 1
  fi
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
  subdomain="$(cf_api /workers/subdomain | jq -r '.result.subdomain')"
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
