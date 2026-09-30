#!/usr/bin/env bash
# Daily snapshot of production `main` as a Neon branch without compute (ADR-0003, backup option A).
# Keeps the newest BACKUP_KEEP snapshots (default 3; Neon Free: 10 branches and 0.5 GB per project).
# Snapshots live with the same provider: they cover mistakes older than Neon's 6 h restore window,
# not a Neon outage; the off-provider dump (option B) is `dump.sh` (ADR-0023).
# Usage: NEON_PROJECT_ID=... [NEON_API_KEY=...] [BACKUP_KEEP=3] [DRY_RUN=1] scripts/backup/snapshot.sh
set -euo pipefail
: "${NEON_PROJECT_ID:?}"
# In CI the key must come from the `production` environment (ADR-0019); fail before any Neon call.
if [ -n "${GITHUB_ACTIONS:-}" ] && [ -z "${NEON_API_KEY:-}" ]; then
  echo "[backup] ERROR: NEON_API_KEY is not set in the production environment" >&2
  exit 1
fi
KEEP="${BACKUP_KEEP:-3}"
# Fail closed: 0 or garbage would prune every snapshot. Max 7 leaves room under Neon Free's
# 10 branches for main plus a restore (see the runbook).
if ! [[ "$KEEP" =~ ^[1-7]$ ]]; then echo "[backup] ERROR: BACKUP_KEEP must be an integer 1-7 (got '$KEEP')" >&2; exit 1; fi
NAME="backup-$(date -u +%Y%m%d)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log() { echo "[backup] $*" >&2; }
neon() {
  if [ -n "${NEON_API_KEY:-}" ]; then pnpm --dir "$ROOT" exec neon --api-key "$NEON_API_KEY" "$@"
  else pnpm --dir "$ROOT" exec neon "$@"; fi
}
branches() {
  neon branches list --project-id "$NEON_PROJECT_ID" --output json | jq 'if type == "array" then . else .branches end'
}

if branches | jq -e --arg n "$NAME" 'any(.name == $n)' >/dev/null; then
  log "$NAME already exists (idempotent re-run)"
else
  log "creating $NAME from main (no compute)"
  [ -n "${DRY_RUN:-}" ] || neon branches create --project-id "$NEON_PROJECT_ID" --name "$NAME" \
    --parent main --no-compute --output json >/dev/null
fi

# Prune: names sort by date; keep the newest $KEEP.
branches | jq -r '.[].name | select(test("^backup-[0-9]{8}$"))' | sort -r | tail -n +"$((KEEP + 1))" |
  while read -r old; do
    log "pruning $old"
    [ -n "${DRY_RUN:-}" ] || neon branches delete "$old" --project-id "$NEON_PROJECT_ID" --output json >/dev/null
  done
log "snapshots now: $(branches | jq -r '[.[].name | select(test("^backup-"))] | sort | join(", ")')"
