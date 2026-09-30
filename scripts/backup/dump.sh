#!/usr/bin/env bash
# Daily off-provider dump of production `main` to Cloudflare R2 (ADR-0023, ADR-0003 backup option B).
# pg_dump (custom format) → check it lists the schema → upload to s3://$R2_BACKUP_BUCKET/daily/app-YYYYMMDD.dump
# with a .sha256 next to it. Retention: the bucket's lifecycle rule (30 days). Encryption: R2's
# managed encryption at rest only; whoever holds the R2 token can read the dumps (ADR-0023).
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

if [ -z "${DRY_RUN:-}" ] && s3api head-object --bucket "$R2_BACKUP_BUCKET" --key "$KEY" >/dev/null 2>&1; then
  log "$KEY already exists (idempotent re-run)"
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  : "${NEON_PROJECT_ID:?}"
  neon() {
    if [ -n "${NEON_API_KEY:-}" ]; then pnpm --dir "$ROOT" exec neon --api-key "$NEON_API_KEY" "$@"
    else pnpm --dir "$ROOT" exec neon "$@"; fi
  }
  # Direct (non-pooler) URL; never printed.
  DATABASE_URL="$(neon connection-string main --project-id "$NEON_PROJECT_ID" --database-name app --role-name app_owner)"
fi
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$DATABASE_URL"
export DATABASE_URL

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Postgres 17 client, matching the server; the URL goes in through the environment, not argv.
pg() { docker run --rm -i --network host -e DATABASE_URL postgres:17-alpine "$@"; }

log "dumping main"
pg sh -c 'pg_dump --format=custom --dbname="$DATABASE_URL"' >"$WORK/$NAME"
# A truncated or empty dump fails here, not at restore time.
pg pg_restore --list <"$WORK/$NAME" >"$WORK/list"
for t in organization member user __drizzle_migrations; do
  grep -Eq "TABLE DATA [a-z_]+ \"?$t\"? " "$WORK/list" || fail "dump has no data entry for table $t"
done
(cd "$WORK" && sha256sum "$NAME" >"$NAME.sha256")
log "dump ok: $(wc -c <"$WORK/$NAME") bytes, $(grep -c 'TABLE DATA' "$WORK/list") tables"

if [ -n "${DRY_RUN:-}" ]; then log "DRY_RUN: not uploading $KEY"; exit 0; fi
s3api put-object --bucket "$R2_BACKUP_BUCKET" --key "$KEY" --body "$WORK/$NAME" >/dev/null
s3api put-object --bucket "$R2_BACKUP_BUCKET" --key "$KEY.sha256" --body "$WORK/$NAME.sha256" >/dev/null
size="$(s3api head-object --bucket "$R2_BACKUP_BUCKET" --key "$KEY" --query ContentLength --output text)"
[ "$size" = "$(wc -c <"$WORK/$NAME")" ] || fail "uploaded size $size doesn't match the local dump"
log "uploaded $KEY ($size bytes)"
