#!/usr/bin/env bash
# Worker side of the daily janitor (ADR-0021): deletes the Previews of PRs that are closed, for runs
# the close event missed. Runs only in the `preview` environment with the narrow per-Worker token;
# `infra.sh janitor` does the same for Hyperdrive configs and Neon branches. Needs GH_TOKEN.
source "$(dirname "$0")/lib.sh"
: "${GH_TOKEN:?}"
cf_worker_preflight

list="$(cf_api "/workers/workers/$PREVIEW_WORKER/previews?per_page=100")"
rc=0
for n in $(jq -r '.result[].name | select(test("^pr-[1-9][0-9]{0,6}$")) | ltrimstr("pr-")' <<<"$list"); do
  pr_is_closed "$n" || continue
  log "closed PR #$n: deleting its preview"
  delete_preview "pr-$n" || rc=1
done
exit "$rc"
