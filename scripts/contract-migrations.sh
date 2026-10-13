#!/usr/bin/env bash
# ADR-0029 decision 7: prints which of the given migration SQL files are contract migrations, i.e.
# drop, rename, move or retype anything (`DROP`, `RENAME`, `SET SCHEMA`, `ALTER [COLUMN] <col> [SET DATA] TYPE`, the
# column plain or double-quoted, spaces included). Each file is read as one record (-z), so a
# statement may wrap across lines. A file that can't be read is an error (exit 2), never "no
# contract". Used by pr-title.yml (the PR title needs `!`), release.yml (contract precondition,
# breaking-release guard) and rollback.yml. Usage: scripts/contract-migrations.sh <file.sql>...
set -euo pipefail
ident='("([^"]|"")+"|[^[:space:]";]+)'
re="\\bDROP\\b|\\bRENAME\\b|\\bSET[[:space:]]+SCHEMA\\b|ALTER[[:space:]]+(COLUMN[[:space:]]+)?${ident}[[:space:]]+(SET[[:space:]]+DATA[[:space:]]+)?TYPE\\b"
for f in "$@"; do
  if grep -qziE "$re" "$f"; then
    printf '%s\n' "$f"
  else
    s=$?
    [ "$s" = 1 ] || { echo "contract-migrations: can't read $f (grep exit $s)" >&2; exit 2; }
  fi
done
