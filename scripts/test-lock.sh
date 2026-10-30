#!/usr/bin/env bash
# One `pnpm test` or `pnpm test:e2e` at a time on this machine: every clone and worktree shares the
# local `app_test` database and port 3000, so the lock is named from the database, not the checkout.
# One lock for all local test resources: it's named after `app_test`, and also guards E2E's dev
# database and port 3000. Don't split it.
# It takes only these two commands, because agents may run it without a prompt
# (.claude/settings.json), so it mustn't become a way to run anything else.
set -euo pipefail
usage() { echo "usage: scripts/test-lock.sh test|e2e [args...]" >&2; exit 2; }
[ $# -ge 1 ] || usage
command -v flock >/dev/null || { echo "test-lock: flock is required (util-linux)." >&2; exit 1; }
case "$1" in
  test) script=test ;;
  e2e) script=test:e2e ;;
  *) usage ;;
esac
kind=$1
shift
top=$(git rev-parse --show-toplevel)
# host-port-database from the test URL, never its credentials. No URL, no lock: refuse rather than
# run unserialized.
database=$(sed -nE "s#.*hyperdrives:.*://[^@']*@([^/']+)/([^'?]+).*#\\1/\\2#p" "$top/apps/app/vitest.config.ts" | head -1 | tr ':/' '--')
[ -n "$database" ] || { echo "test-lock: no test database URL in apps/app/vitest.config.ts." >&2; exit 1; }
locks="$HOME/.cache/saas-foundation/locks"
common=$(git rev-parse --git-common-dir)
mkdir -p "$locks" "$common/test-logs"
# Agents' tools truncate long output, so each run keeps its full output, outside the worktree.
log="$common/test-logs/$(basename "$top")-$kind-$(date +%Y%m%dT%H%M%S)-$$.log"
# Printed first as well: a tool that truncates long output may lose the last line.
echo "test-lock: full output in $log"
status=0
flock "$locks/$database.lock" pnpm "$script" "$@" 2>&1 | tee "$log" || status=$?
echo "test-lock: exit $status, full output in $log"
exit "$status"
