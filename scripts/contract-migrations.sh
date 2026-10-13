#!/usr/bin/env bash
# ADR-0029 decision 7: prints which of the given migration SQL files are contract migrations, i.e.
# drop, rename or retype anything (`DROP`, `RENAME`, `ALTER [COLUMN] <col> [SET DATA] TYPE`).
# Each file is read as one record (-z), so a statement may wrap across lines. Used by
# pr-title.yml (the PR title needs `!`), release.yml (contract precondition) and rollback.yml
# (breaking-release guard). Usage: scripts/contract-migrations.sh <file.sql>...
set -euo pipefail
re='\bDROP\b|\bRENAME\b|ALTER[[:space:]]+(COLUMN[[:space:]]+)?[^[:space:]]+[[:space:]]+(SET[[:space:]]+DATA[[:space:]]+)?TYPE\b'
for f in "$@"; do
  if grep -qziE "$re" "$f"; then printf '%s\n' "$f"; fi
done
