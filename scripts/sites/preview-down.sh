#!/usr/bin/env bash
# Deletes a closed PR's static site Preview (ADR-0028, ADR-0033): scripts/preview/down.sh pointed
# at the site's preview Worker. Tidiness only: a site preview holds no data, and deleted Previews
# may keep serving (ADR-0021). Usage: SITE=docs PR_NUMBER=123 GH_TOKEN=... scripts/sites/preview-down.sh
source "$(dirname "$0")/lib.sh"
require_account
PREVIEW_WORKER="$SITE_WORKER-preview" exec "$ROOT/scripts/preview/down.sh"
