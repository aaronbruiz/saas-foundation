#!/usr/bin/env bash
# Create or update the preview for one PR (ADR-0011). Idempotent: safe to re-run on every push.
# Usage: PR_NUMBER=123 scripts/preview/up.sh
# Output: in GitHub Actions writes `url=<preview URL>` to $GITHUB_OUTPUT; otherwise prints it.
# SECURITY: stdout is reserved for workflow commands (::add-mask::). Never capture this script's
# stdout, never print the connection string. (A captured stdout leaked a masked URL once: PR #4.)
source "$(dirname "$0")/lib.sh"
: "${PR_NUMBER:?}"
names_for "$PR_NUMBER"
cf_token_preflight

# 1. Neon branch from preview-seed (synthetic data only), in the separate preview project.
if neon_branch_exists "$NEON_BRANCH"; then
  log "reusing Neon branch $NEON_BRANCH"
else
  count="$(neon_branches_json | jq 'length')"
  if [ "$count" -ge "$NEON_MAX_BRANCHES" ]; then
    log "ERROR: preview slots exhausted ($count/$NEON_MAX_BRANCHES Neon branches). Close PRs or run the janitor."
    exit 1
  fi
  log "creating Neon branch $NEON_BRANCH from $NEON_PREVIEW_PARENT_BRANCH"
  neon branches create --project-id "$NEON_PREVIEW_PROJECT_ID" --name "$NEON_BRANCH" \
    --parent "$NEON_PREVIEW_PARENT_BRANCH" --output json >/dev/null
fi

# Direct (non-pooler) URL: Hyperdrive does the pooling. Never printed.
db_url="$(neon connection-string "$NEON_BRANCH" --project-id "$NEON_PREVIEW_PROJECT_ID" \
  --database-name "$NEON_DATABASE" --role-name "$NEON_ROLE")"
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$db_url"

# 2. Migrations against the branch.
log "migrating $NEON_BRANCH"
DATABASE_URL="$db_url" pnpm --dir "$ROOT" db:migrate >&2

# 3. Hyperdrive config for this PR, caching disabled (ADR-0004).
hd_id="$(hyperdrive_id_by_name "$HYPERDRIVE_NAME")"
if [ -z "$hd_id" ]; then
  log "creating Hyperdrive $HYPERDRIVE_NAME"
  wrangler hyperdrive create "$HYPERDRIVE_NAME" --connection-string="$db_url" --caching-disabled >/dev/null
  hd_id="$(hyperdrive_id_by_name "$HYPERDRIVE_NAME")"
fi
[ -n "$hd_id" ] || { log "ERROR: Hyperdrive $HYPERDRIVE_NAME not found after create"; exit 1; }

# 4. Point the committed fail-closed previews sentinel at this PR's Hyperdrive config, BEFORE the
#    build (the Vite plugin bakes config). Idempotent: re-runs replace the id.
node "$ROOT/scripts/preview/inject-previews.mjs" "$ROOT/apps/web/wrangler.jsonc" "$hd_id"
# Per-deploy preview auth secret, generated before the build so the bundle scan checks it too.
auth_secret="$(openssl rand -base64 32)"
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$auth_secret"
pnpm --dir "$ROOT" build >&2
BETTER_AUTH_SECRET="$auth_secret" "$ROOT/scripts/scan-client-bundle.sh" "$ROOT/apps/web/dist/client"

# 5. Deploy the preview with its own auth settings. Previews hold synthetic data only, so sign-up
#    is open there (ADR-0014; production defaults to closed). The URL is deterministic, so Better Auth's
#    origin checks match it; the secret is random per deploy (never stored, sessions reset on push).
subdomain="$(cf_api /workers/subdomain | jq -r '.result.subdomain')"
auth_url="https://${PREVIEW_NAME}-${PREVIEW_WORKER}.${subdomain}.workers.dev"
secrets_file="$(mktemp)"
trap 'rm -f "$secrets_file"' EXIT
chmod 600 "$secrets_file"
printf 'BETTER_AUTH_SECRET=%s\n' "$auth_secret" >"$secrets_file"
out="$(wrangler preview --worker-name "$PREVIEW_WORKER" --name "$PREVIEW_NAME" --message "${GITHUB_SHA:-manual}" --json \
  --var "BETTER_AUTH_URL:$auth_url" --var "SIGNUP_MODE:open" --secrets-file "$secrets_file")"
url="$(printf '%s' "$out" | node -e '
  const t = require("fs").readFileSync(0, "utf8"); const i = t.indexOf("{\n  \"preview\"");
  const d = JSON.parse(t.slice(i)); process.stdout.write(d.preview.urls[0]);')"
# Defense in depth: only a plain workers.dev URL may leave this script.
[[ "$url" =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$ ]] ||
  { log "ERROR: unexpected preview URL shape; refusing to output it"; exit 1; }

# 6. Smoke test: the preview reaches its own database through Hyperdrive.
for i in $(seq 1 10); do
  if curl -fsS "$url/api/health" | jq -e '.ok == true' >/dev/null; then
    log "health OK: $url/api/health"
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "url=$url" >>"$GITHUB_OUTPUT"; else echo "$url"; fi
    exit 0
  fi
  sleep 3
done
log "ERROR: $url/api/health did not become healthy"; exit 1
