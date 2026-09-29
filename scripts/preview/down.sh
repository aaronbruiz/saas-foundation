#!/usr/bin/env bash
# Worker side of a PR's teardown (ADR-0021): deletes its Worker Preview. Runs only in the `preview`
# environment with the narrow per-Worker token. The PR's data (Hyperdrive config + Neon branch) is
# revoked separately by `infra.sh down` in the `preview-infra` environment: old deployments of a
# deleted Preview may keep executing, so this step is hygiene, not the security boundary. Idempotent.
# Usage: PR_NUMBER=123 GH_TOKEN=... scripts/preview/down.sh   (FORCE=1 skips the closed-state check,
# e.g. for manual test PR numbers)
source "$(dirname "$0")/lib.sh"
: "${PR_NUMBER:?}"
names_for "$PR_NUMBER"
# A delayed close event can arrive after the PR was reopened: destroy nothing unless GitHub says
# it's closed right now.
if [ -z "${FORCE:-}" ] && ! pr_is_closed "$PR_NUMBER"; then
  log "PR #$PR_NUMBER isn't closed (or its state is unknown); nothing to do"
  exit 0
fi
cf_worker_preflight
delete_preview "$PREVIEW_NAME"
