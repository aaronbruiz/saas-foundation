#!/usr/bin/env bash
# Migrate production with the artifact's migrations (ADR-0029 decision 3, steps 3–4), with the Neon
# key only. In order, refusing before anything changes:
#  1. Breaking-release guard (decision 6), on every deploy: production has applied a contract
#     migration the tag lacks (an older tag, or a release re-run after newer ones migrated) →
#     refuse unless CONFIRM_BREAKING=true.
#  2. Pending = the tag's journal entries production hasn't applied. drizzle applies only entries
#     newer than the newest applied one, so an older pending entry (a merged journal) would be
#     skipped silently: refuse.
#  3. Contract precondition (decision 7): a pending migration that drops, renames, moves or retypes
#     anything needs the immediately preceding release ($PREV_TAG) live at 100%: preflight's live
#     tag ($LIVE_TAG, read from the deployment) must be it, and /api/health must report it.
#  4. Only when something is pending: restore point (restore-point.sh), then `main`'s trusted
#     migrator applies the tag's SQL and journal as data.
# Usage: NEON_API_KEY=... NEON_PROJECT_ID=... ARTIFACT_DIR=... TAG=... PREV_TAG=... LIVE_TAG=...
#        [CONFIRM_BREAKING=true] scripts/release/migrate.sh
source "$(dirname "$0")/lib.sh"
: "${ARTIFACT_DIR:?}" "${TAG:?}"
migrations="$ARTIFACT_DIR/packages/db/drizzle"
journal="$migrations/meta/_journal.json"
[ -f "$journal" ] || die "artifact has no packages/db/drizzle journal"

load_prod_db_url
applied="$(applied_migrations)"
log "production has applied $(jq length <<<"$applied") migrations"

missing=() pending=() contracts=()
out="$(applied_contracts_missing_from "$applied" "$journal" "$ROOT/packages/db/drizzle")"
lines_to "$out" missing
if ((${#missing[@]})); then
  log "production has applied contract migrations that $TAG lacks: ${missing[*]#"$ROOT/"}"
  [ "${CONFIRM_BREAKING:-}" = true ] || die "refusing to deploy $TAG (redeploy with confirm_breaking: true if its code works on this schema)"
  log "confirm_breaking: true; continuing"
fi

out="$(jq -r --argjson a "$applied" '($a | map(.created_at)) as $done | ($done | max) as $newest
  | .entries[] | select(.when as $w | $done | index($w) | not)
  | if .when <= $newest then "OUT_OF_ORDER \(.tag)" else .tag end' "$journal")"
lines_to "$out" pending
for p in "${pending[@]}"; do
  [[ "$p" != OUT_OF_ORDER* ]] || die "${p#OUT_OF_ORDER } is older than the newest applied migration; drizzle would skip it. Regenerate it after the newer ones"
done
if ((${#pending[@]} == 0)); then
  log "no pending migrations: nothing to apply, no restore point"
  exit 0
fi
log "pending migrations: ${pending[*]}"

out="$(unapplied_contracts "$migrations" "$applied")"
lines_to "$out" contracts
if ((${#contracts[@]})); then
  log "pending contract migrations: ${contracts[*]#"$migrations/"}"
  [ -n "${PREV_TAG:-}" ] || die "contract migration pending but no preceding release tag"
  [ "${LIVE_TAG:-}" = "$PREV_TAG" ] ||
    die "contract precondition: the deployment serves ${LIVE_TAG:-an untagged version}, not $PREV_TAG; release $PREV_TAG first"
  body="$(curl -sS -m 15 "https://$APP_HOST/api/health" || true)"
  jq -e --arg v "${PREV_TAG#web-v}" '.version == $v' <<<"$body" >/dev/null 2>&1 ||
    die "contract precondition: /api/health doesn't report $PREV_TAG (${body:-no response})"
  log "contract precondition met: production serves $PREV_TAG"
fi

"$(dirname "$0")/restore-point.sh"
DATABASE_URL="$DB_URL" node "$ROOT/packages/db/scripts/migrate.mjs" "$migrations"
