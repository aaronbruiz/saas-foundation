#!/usr/bin/env bash
# Migrate production with the artifact's migrations (ADR-0029 decision 3, step 4): `main`'s trusted
# migrator applies the tag's SQL and journal as data, so redeploying an older tag applies nothing
# new. Contract precondition (decision 7): if a pending migration drops, renames or retypes
# anything, production must serve the immediately preceding release ($PREV_TAG) at 100% (preflight
# already refused a held candidate); otherwise stop before migrating.
# With GUARD=1 (redeploy), first the rollback guard of decision 6: refuse if production has applied
# a contract migration the tag lacks, unless CONFIRM_BREAKING=true.
# Usage: NEON_API_KEY=... NEON_PROJECT_ID=... ARTIFACT_DIR=... TAG=... PREV_TAG=... [GUARD=1]
#        scripts/release/migrate.sh
source "$(dirname "$0")/lib.sh"
: "${ARTIFACT_DIR:?}" "${TAG:?}"
migrations="$ARTIFACT_DIR/packages/db/drizzle"
[ -f "$migrations/meta/_journal.json" ] || die "artifact has no packages/db/drizzle journal"

load_prod_db_url
applied="$(applied_migrations)"
log "production has applied $(jq length <<<"$applied") migrations"

if [ -n "${GUARD:-}" ]; then
  out="$(applied_contracts_missing_from "$applied" "$migrations/meta/_journal.json" "$ROOT/packages/db/drizzle")"
  lines_to "$out" missing
  if ((${#missing[@]})); then
    log "production has applied contract migrations that $TAG lacks: ${missing[*]#"$ROOT/"}"
    [ "${CONFIRM_BREAKING:-}" = true ] || die "refusing to redeploy $TAG (rerun with confirm_breaking: true if its code works on this schema)"
    log "confirm_breaking: true; continuing"
  fi
fi

out="$(unapplied_contracts "$migrations" "$applied")"
lines_to "$out" contracts
if ((${#contracts[@]})); then
  log "pending contract migrations: ${contracts[*]#"$migrations/"}"
  [ -n "${PREV_TAG:-}" ] || die "contract migration pending but no preceding release tag"
  body="$(curl -sS -m 15 "https://$APP_HOST/api/health" || true)"
  jq -e --arg v "${PREV_TAG#web-v}" '.version == $v' <<<"$body" >/dev/null 2>&1 ||
    die "contract precondition: production must serve $PREV_TAG at 100% before this migration runs (health: ${body:-no response})"
  log "contract precondition met: production serves $PREV_TAG"
fi

DATABASE_URL="$DB_URL" node "$ROOT/packages/db/scripts/migrate.mjs" "$migrations"
