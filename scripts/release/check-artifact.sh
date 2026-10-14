#!/usr/bin/env bash
# Validates a release artifact before anything in production changes (ADR-0029, with ADR-0021's
# artifact-as-data rules): plain files only, no env files, a journal, and a Worker config that
# prepare-config.mjs --production accepts (no custom build, no_bundle, paths confined to the
# artifact, only the production DB and the committed email binding). No credentials needed.
# Usage: ARTIFACT_DIR=... scripts/release/check-artifact.sh
source "$(dirname "$0")/lib.sh"
: "${ARTIFACT_DIR:?}"
artifact="$(cd "$ARTIFACT_DIR" && pwd -P)"
check_artifact_files "$artifact" || exit 1
node "$ROOT/scripts/preview/prepare-config.mjs" "$artifact/apps/app/dist/server/wrangler.json" "$ACCOUNT" --production "$PROD_HYPERDRIVE_ID"
