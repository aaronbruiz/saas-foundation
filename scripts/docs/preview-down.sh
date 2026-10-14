#!/usr/bin/env bash
# Deletes a closed PR's docs Preview (ADR-0028): scripts/preview/down.sh pointed at the docs
# preview Worker. Tidiness only: a docs preview holds no data, and deleted Previews may keep serving
# (ADR-0021). Usage: PR_NUMBER=123 GH_TOKEN=... scripts/docs/preview-down.sh
source "$(dirname "$0")/lib.sh"
PREVIEW_WORKER="$DOCS_WORKER-preview" exec "$ROOT/scripts/preview/down.sh"
