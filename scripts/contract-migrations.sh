#!/usr/bin/env bash
# ADR-0029 decision 7: prints which of the given migration SQL files are contract migrations, i.e.
# drop, rename, move or retype anything (`DROP`, `RENAME`, `SET SCHEMA`, `ALTER [COLUMN] <col>
# [SET DATA] TYPE`, the column plain or double-quoted, spaces included). SQL comments are removed
# first (PostgreSQL treats them as whitespace, so they could split a keyword pair); a comment marker
# left over (a nested block comment) counts as a contract, failing closed. Each file is read whole,
# so a statement may wrap across lines. A file that can't be read is an error (exit 2), never "no
# contract". Used by pr-title.yml (the PR title needs `!`), release.yml (contract precondition,
# breaking-release guard) and rollback.yml. Usage: scripts/contract-migrations.sh <file.sql>...
set -euo pipefail
ident='("([^"]|"")+"|[^[:space:]";]+)'
re="\\bDROP\\b|\\bRENAME\\b|\\bSET[[:space:]]+SCHEMA\\b|ALTER[[:space:]]+(COLUMN[[:space:]]+)?${ident}[[:space:]]+(SET[[:space:]]+DATA[[:space:]]+)?TYPE\\b|/\\*|\\*/"
for f in "$@"; do
  [ -f "$f" ] || { echo "contract-migrations: $f is not a file" >&2; exit 2; }
  # Innermost block comments, then line comments, each replaced by a space.
  # A redirect, not a perl argument: perl only warns about a file it can't open, and exits 0.
  sql="$(perl -0777 -pe 's{/\*(?:(?!/\*).)*?\*/}{ }gs; s{--[^\n]*}{ }g' <"$f")" ||
    { echo "contract-migrations: can't read $f" >&2; exit 2; }
  if grep -qziE "$re" <<<"$sql"; then printf '%s\n' "$f"; fi
done
