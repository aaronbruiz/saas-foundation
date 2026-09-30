#!/usr/bin/env bash
# Daily off-provider dump of production `main` to Cloudflare R2 (ADR-0023, ADR-0003 backup option B).
# pg_dump (custom format) → check it lists the schema → upload to s3://$R2_BACKUP_BUCKET/daily/app-YYYYMMDD.dump,
# check its size, then upload the .sha256 next to it; the .sha256 marks the day's backup complete.
# Retention: the bucket's lifecycle rule (30 days). Encryption: R2's managed encryption at rest only;
# whoever holds the R2 token can read the dumps (ADR-0023).
# Usage: NEON_PROJECT_ID=... [NEON_API_KEY=...] R2_BACKUP_ENDPOINT=... R2_BACKUP_BUCKET=...
#        AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... [DRY_RUN=1] scripts/backup/dump.sh
# DATABASE_URL skips the Neon lookup (local testing: DATABASE_URL=postgres://... DRY_RUN=1).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log() { echo "[dump] $*" >&2; }
fail() { echo "[dump] ERROR: $*" >&2; exit 1; }
# In CI every credential must come from the `production` environment; fail before any call.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  for v in NEON_API_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_BACKUP_ENDPOINT R2_BACKUP_BUCKET; do
    [ -n "${!v:-}" ] || fail "$v is not set in the production environment"
  done
fi
if [ -z "${DRY_RUN:-}" ]; then
  : "${R2_BACKUP_ENDPOINT:?}" "${R2_BACKUP_BUCKET:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
fi

NAME="app-$(date -u +%Y%m%d).dump"
KEY="daily/$NAME"
export AWS_DEFAULT_REGION=auto
# R2 doesn't need the AWS CLI's default request checksums; send them only when an operation requires one.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
s3api() { aws s3api --endpoint-url "$R2_BACKUP_ENDPOINT" "$@"; }

# Exit 0 if the object exists, 1 if it doesn't; anything else (auth, network) fails the run.
exists() {
  local err
  if err="$(s3api head-object --bucket "$R2_BACKUP_BUCKET" --key "$1" 2>&1 >/dev/null)"; then return 0; fi
  grep -Eq '\((404|NoSuchKey|Not Found)\)' <<<"$err" && return 1
  fail "can't check $1: $err"
}
# The .sha256 is uploaded last, so a run that failed halfway is redone, not skipped.
if [ -z "${DRY_RUN:-}" ] && exists "$KEY.sha256"; then
  log "$KEY already complete (idempotent re-run)"
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  : "${NEON_PROJECT_ID:?}"
  # The CLI reads NEON_API_KEY from the environment (its --api-key default), so the key stays out of argv.
  # Direct (non-pooler) URL; never printed.
  DATABASE_URL="$(pnpm --dir "$ROOT" exec neon connection-string main --project-id "$NEON_PROJECT_ID" \
    --database-name app --role-name app_owner)"
fi
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$DATABASE_URL"
export DATABASE_URL

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# libpq reads the connection from PG* variables in an env file, so neither the URL nor the password
# appears in any process's arguments (a --dbname URL would).
(umask 077 && node -e '
  const u = new URL(process.env.DATABASE_URL), q = u.searchParams, d = decodeURIComponent
  const env = { PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: d(u.username),
    PGPASSWORD: d(u.password), PGDATABASE: d(u.pathname.slice(1)),
    PGSSLMODE: q.get("sslmode"), PGCHANNELBINDING: q.get("channel_binding"), PGOPTIONS: q.get("options") }
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue
    // An env file holds one line per variable; fail on a value it cannot carry (name only, never the value).
    if (/[\r\n]/.test(v)) { console.error(`[dump] ERROR: ${k} contains a line break`); process.exit(1) }
    console.log(`${k}=${v}`)
  }
' >"$WORK/pg.env")
# Postgres 17 client, matching the server.
pg() { docker run --rm -i --network host --env-file "$WORK/pg.env" postgres:17-alpine "$@"; }

log "dumping main"
pg pg_dump --format=custom >"$WORK/$NAME"
# A truncated or empty dump fails here, not at restore time.
pg pg_restore --list <"$WORK/$NAME" >"$WORK/list"
for t in organization member user __drizzle_migrations; do
  grep -Eq "TABLE DATA [a-z_]+ \"?$t\"? " "$WORK/list" || fail "dump has no data entry for table $t"
done
(cd "$WORK" && sha256sum "$NAME" >"$NAME.sha256")
log "dump ok: $(wc -c <"$WORK/$NAME") bytes, $(grep -c 'TABLE DATA' "$WORK/list") tables"

if [ -n "${DRY_RUN:-}" ]; then log "DRY_RUN: not uploading $KEY"; exit 0; fi
s3api put-object --bucket "$R2_BACKUP_BUCKET" --key "$KEY" --body "$WORK/$NAME" >/dev/null
size="$(s3api head-object --bucket "$R2_BACKUP_BUCKET" --key "$KEY" --query ContentLength --output text)"
[ "$size" = "$(wc -c <"$WORK/$NAME")" ] || fail "uploaded size $size doesn't match the local dump"
s3api put-object --bucket "$R2_BACKUP_BUCKET" --key "$KEY.sha256" --body "$WORK/$NAME.sha256" >/dev/null
log "uploaded $KEY ($size bytes) and $KEY.sha256"
