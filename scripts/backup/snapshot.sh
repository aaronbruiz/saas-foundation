#!/usr/bin/env bash
# Daily snapshot of production `main` as a Neon branch without compute (ADR-0003, backup option A).
# Keeps the newest BACKUP_KEEP snapshots (default 3; Neon Free: 10 branches and 0.5 GB per project).
# Snapshots live with the same provider: they cover mistakes older than Neon's 6 h restore window,
# not a Neon outage. An off-provider dump (option B) is registered for later in ADR-0003.
# Usage: NEON_PROJECT_ID=... [NEON_API_KEY=...] [BACKUP_KEEP=3] [DRY_RUN=1] scripts/backup/snapshot.sh
set -euo pipefail
: "${NEON_PROJECT_ID:?}"
KEEP="${BACKUP_KEEP:-3}"
NAME="backup-$(date -u +%Y%m%d)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log() { echo "[backup] $*" >&2; }
neon() {
  if [ -n "${NEON_API_KEY:-}" ]; then pnpm --dir "$ROOT" exec neonctl --api-key "$NEON_API_KEY" "$@"
  else pnpm --dir "$ROOT" exec neonctl "$@"; fi
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
