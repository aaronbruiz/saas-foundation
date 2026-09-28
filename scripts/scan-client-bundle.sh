#!/usr/bin/env bash
# Fails if browser-served assets contain secret VALUES (AGENTS.md invariant 8). Names alone are
# fine (e.g. Better Auth's env helper references `BETTER_AUTH_SECRET` by name and returns
# undefined in the browser). Checks: connection strings with credentials, Neon passwords, and the
# actual values from apps/web/.dev.vars when present (what a bad Vite `define` would inline).
# Usage: scripts/scan-client-bundle.sh [dist/client dir]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:-$root/apps/web/dist/client}"
[ -d "$dir" ] || { echo "[scan] no client bundle at $dir (build first)" >&2; exit 1; }
found=0
if grep -rIlE 'postgres(ql)?://[^"'"'"' ]+:[^"'"'"' @]+@|npg_[A-Za-z0-9]{8,}' "$dir"; then found=1; fi
if [ -f "$root/apps/web/.dev.vars" ]; then
  while IFS='=' read -r key value; do
    [ "${#value}" -ge 16 ] || continue
    if grep -rIlF -- "$value" "$dir"; then echo "[scan] value of $key found" >&2; found=1; fi
  done < <(grep -E '^[A-Z_]+=' "$root/apps/web/.dev.vars")
fi
[ "$found" = 0 ] || { echo "[scan] ERROR: secret material in the client bundle (files above)" >&2; exit 1; }
echo "[scan] client bundle clean ($(find "$dir" -type f | wc -l) files)" >&2
