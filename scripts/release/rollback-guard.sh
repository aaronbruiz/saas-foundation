#!/usr/bin/env bash
# Rollback, step 2 (ADR-0029 decision 6), with the Neon key only: compares the migrations
# production has applied with the target commit's migration journal. Applied contract migrations
# the target lacks (or a target commit that's unknown) make the rollback breaking: refuse unless
# CONFIRM_BREAKING=true. Comparing applied migrations, not releases, also covers a release whose
# migration ran but whose candidate failed or was held. Needs the full history fetched.
# Usage: NEON_API_KEY=... NEON_PROJECT_ID=... COMMIT=<sha or empty> [CONFIRM_BREAKING=true]
#        scripts/release/rollback-guard.sh
source "$(dirname "$0")/lib.sh"

breaking=()
if [ -z "${COMMIT:-}" ]; then
  breaking=("target commit unknown (not deployed by release.yml)")
else
  journal="$(mktemp)"
  git -C "$ROOT" show "$COMMIT:packages/db/drizzle/meta/_journal.json" >"$journal" ||
    die "can't read the journal at $COMMIT"
  load_prod_db_url
  applied="$(applied_migrations)"
  out="$(applied_contracts_missing_from "$applied" "$journal" "$ROOT/packages/db/drizzle")"
  lines_to "$out" breaking
fi
if ((${#breaking[@]})); then
  log "breaking rollback: ${breaking[*]#"$ROOT/"}"
  [ "${CONFIRM_BREAKING:-}" = true ] || die "refusing (rerun with confirm_breaking: true if the target's code works on today's schema)"
  log "confirm_breaking: true; continuing"
else
  log "no applied contract migration is missing from the target"
fi
