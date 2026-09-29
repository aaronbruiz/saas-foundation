#!/usr/bin/env bash
# Per-PR preview data (ADR-0021): Neon branch `preview/pr-N` + Hyperdrive config `saas-pr-N`.
# Runs ONLY in the `preview-infra` environment, with the Hyperdrive Write token as
# CLOUDFLARE_API_TOKEN and the preview-project Neon key. It never receives the PR's build artifact
# and runs no package code: curl + jq against the Cloudflare and Neon APIs only.
#   up      create the branch (fresh per-branch role password) or reset its data to the seed; create
#           the Hyperdrive config if missing. Writes `hyperdrive_id=<id>` to $GITHUB_OUTPUT (or prints it).
#   down    delete the Hyperdrive config, then the branch. Deleting the config is what revokes
#           database access: old Preview deployments may keep executing (Cloudflare Previews beta).
#   janitor `down` for every saas-pr-N config / preview/pr-N branch whose PR is closed (needs GH_TOKEN).
# Hyperdrive ids are never reused between PRs: a closed PR's config is deleted, a new one is created.
# Usage: PR_NUMBER=123 scripts/preview/infra.sh up|down   ·   scripts/preview/infra.sh janitor
# SECURITY: never prints connection strings or passwords.
source "$(dirname "$0")/lib.sh"
: "${NEON_API_KEY:?}" "${NEON_PREVIEW_PROJECT_ID:?}"

# Host of the read-write endpoint of branch id $1 (empty if none).
branch_host() {
  neon_api /endpoints | jq -r --arg b "$1" '[.endpoints[] | select(.branch_id == $b and .type == "read_write") | .host][0] // empty'
}

# Guard (ADR-0021) before using or deleting Hyperdrive config $1. Refuses unless:
#   - the id isn't the production config pinned in wrangler.jsonc;
#   - its name is exactly $2 (saas-pr-<N>);
#   - for `use`: its origin is exactly host $3 (this PR's branch endpoint);
#     for `delete`: its origin isn't the production origin (a config whose branch is already gone
#     no longer points at a live preview endpoint, so only production is excluded there).
# CI never updates an existing config: it creates, reuses (guard passed) or deletes.
hd_guard() {
  local id="$1" want="$2" mode="$3" host="${4:-}" cfg name origin prod
  [[ "$id" =~ ^[0-9a-f]{32}$ ]] || { log "GUARD: malformed Hyperdrive id"; return 1; }
  [ "$id" != "$PROD_HYPERDRIVE_ID" ] || { log "GUARD: refusing the production Hyperdrive config"; return 1; }
  [[ "$want" =~ ^saas-pr-[1-9][0-9]{0,6}$ ]] || { log "GUARD: bad expected name"; return 1; }
  cfg="$(cf_api "/hyperdrive/configs/$id")" || return 1
  name="$(jq -r .result.name <<<"$cfg")"
  origin="$(jq -r .result.origin.host <<<"$cfg")"
  [ "$name" = "$want" ] || { log "GUARD: $id is named '$name', not '$want'"; return 1; }
  case "$mode" in
    use)
      [ -n "$host" ] && [ "$origin" = "$host" ] || { log "GUARD: $id doesn't point at $NEON_BRANCH"; return 1; } ;;
    delete)
      prod="$(cf_api "/hyperdrive/configs/$PROD_HYPERDRIVE_ID" | jq -r .result.origin.host)" || return 1
      [ -n "$prod" ] && [ "$origin" != "$prod" ] || { log "GUARD: $id points at the production origin"; return 1; } ;;
    *) return 1 ;;
  esac
}

# Ids of configs named exactly $1.
hd_ids_named() {
  local list
  list="$(cf_api /hyperdrive/configs)" || return 1
  jq -r --arg n "$1" '.result[] | select(.name == $n) | .id' <<<"$list"
}

hd_delete() { # $1 = id; guarded
  hd_guard "$1" "$HYPERDRIVE_NAME" delete || return 1
  cf_api "/hyperdrive/configs/$1" -X DELETE >/dev/null || return 1
  log "deleted Hyperdrive $HYPERDRIVE_NAME ($1)"
}

# Sets a fresh password for the branch role and creates the config with it. The password only
# lives in this function's environment (not argv), masked in Actions.
hd_create() { # $1 = branch id, $2 = endpoint host
  local reset id
  reset="$(neon_api "/branches/$1/roles/$NEON_ROLE/reset_password" -X POST)" || return 1
  PGPASS="$(jq -r .role.password <<<"$reset")"
  unset reset
  [ -n "$PGPASS" ] && [ "$PGPASS" != null ] || { log "ERROR: no password from the role reset"; return 1; }
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$PGPASS"
  log "set a fresh $NEON_ROLE password on $NEON_BRANCH"
  # Cloudflare checks the origin on create; the new password can take a moment to apply.
  for _ in $(seq 1 10); do
    if id="$(PGPASS="$PGPASS" jq -n --arg n "$HYPERDRIVE_NAME" --arg h "$2" --arg d "$NEON_DATABASE" --arg u "$NEON_ROLE" \
      '{name: $n, caching: {disabled: true}, origin: {scheme: "postgresql", host: $h, port: 5432, database: $d, user: $u, password: env.PGPASS}}' |
      cf_api /hyperdrive/configs -X POST --data-binary @- | jq -r .result.id)"; then
      break
    fi
    id=""
    sleep 5
  done
  unset PGPASS
  [ -n "$id" ] || { log "ERROR: creating Hyperdrive $HYPERDRIVE_NAME failed"; return 1; }
  hd_guard "$id" "$HYPERDRIVE_NAME" use "$2" || return 1
  HD_ID="$id"
  log "created Hyperdrive $HYPERDRIVE_NAME ($HD_ID)"
}

infra_up() {
  local bid seed host ids id body
  bid="$(neon_branch_id "$NEON_BRANCH")" || return 1
  if [ -z "$bid" ]; then
    seed="$(neon_branch_id "$NEON_PREVIEW_PARENT_BRANCH")" || return 1
    [ -n "$seed" ] || { log "ERROR: no $NEON_PREVIEW_PARENT_BRANCH branch in the preview project"; return 1; }
    log "creating $NEON_BRANCH from $NEON_PREVIEW_PARENT_BRANCH"
    # Bodies as arguments, not stdin: neon_api may retry (HTTP 423). They hold no secrets.
    body="$(jq -nc --arg n "$NEON_BRANCH" --arg p "$seed" '{branch: {name: $n, parent_id: $p}, endpoints: [{type: "read_write"}]}')"
    bid="$(neon_api /branches -X POST --data-binary "$body" | jq -r .branch.id)" || return 1
  else
    # Fresh synthetic data on every deploy; roles, password and endpoint are kept, so the PR's
    # Hyperdrive config stays valid.
    log "resetting $NEON_BRANCH data to its parent"
    seed="$(neon_api "/branches/$bid" | jq -r .branch.parent_id)" || return 1
    body="$(jq -nc --arg p "$seed" '{source_branch_id: $p}')"
    neon_api "/branches/$bid/restore" -X POST --data-binary "$body" >/dev/null || return 1
  fi
  host="$(branch_host "$bid")" || return 1
  [ -n "$host" ] || { log "ERROR: $NEON_BRANCH has no read-write endpoint"; return 1; }

  HD_ID=""
  ids="$(hd_ids_named "$HYPERDRIVE_NAME")" || return 1
  for id in $ids; do
    if [ -z "$HD_ID" ] && hd_guard "$id" "$HYPERDRIVE_NAME" use "$host" 2>/dev/null; then
      HD_ID="$id"
      log "reusing Hyperdrive $HYPERDRIVE_NAME ($HD_ID)"
    else
      # Left from an earlier branch of this PR (or a duplicate): never reuse it.
      hd_delete "$id" || return 1
    fi
  done
  [ -n "$HD_ID" ] || hd_create "$bid" "$host" || return 1
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "hyperdrive_id=$HD_ID" >>"$GITHUB_OUTPUT"; else echo "$HD_ID"; fi
}

infra_down() {
  local ids id bid
  ids="$(hd_ids_named "$HYPERDRIVE_NAME")" || return 1
  for id in $ids; do hd_delete "$id" || return 1; done
  bid="$(neon_branch_id "$NEON_BRANCH")" || return 1
  if [ -n "$bid" ]; then
    neon_api "/branches/$bid" -X DELETE >/dev/null || return 1
    log "deleted Neon branch $NEON_BRANCH"
  fi
  log "done: data of pr-$PR_NUMBER revoked"
}

infra_janitor() {
  local hd branches candidates n rc=0
  # Each listing is checked on its own: an incomplete scan must fail, not look clean.
  hd="$(cf_api /hyperdrive/configs)" || return 1
  branches="$(neon_api /branches)" || return 1
  candidates="$( {
    jq -r '.result[].name | select(test("^saas-pr-[1-9][0-9]{0,6}$")) | ltrimstr("saas-pr-")' <<<"$hd"
    jq -r '.branches[].name | select(test("^preview/pr-[1-9][0-9]{0,6}$")) | ltrimstr("preview/pr-")' <<<"$branches"
  } | sort -u)"
  for n in $candidates; do
    pr_is_closed "$n" || continue
    log "closed PR #$n: revoking its preview data"
    PR_NUMBER="$n"
    names_for "$n"
    infra_down || { log "WARN: cleanup of #$n failed; next run retries"; rc=1; }
  done
  return "$rc"
}

case "${1:-}" in
  up | down)
    : "${PR_NUMBER:?}"
    names_for "$PR_NUMBER"
    # A delayed close event can arrive after the PR was reopened: revoke nothing unless GitHub says
    # it's closed right now. FORCE=1 for manual runs (e.g. test PR numbers).
    if [ "$1" = down ] && [ -z "${FORCE:-}" ] && ! pr_is_closed "$PR_NUMBER"; then
      log "PR #$PR_NUMBER isn't closed (or its state is unknown); nothing to do"
      exit 0
    fi
    cf_token_preflight
    "infra_$1"
    ;;
  janitor) : "${GH_TOKEN:?}"; cf_token_preflight; infra_janitor ;;
  *) log "usage: PR_NUMBER=<n> $0 up|down  |  $0 janitor"; exit 1 ;;
esac
