#!/usr/bin/env bash
# One `pnpm test`, `test:e2e` or `test:visual` at a time on this machine: every clone and worktree
# shares `app_test`, E2E's dev database and port 3000, so one lock, named after `app_test` (not the
# checkout), guards them all. Don't split it.
# It takes only these three commands, because agents may run it without a prompt
# (.claude/settings.json), so it mustn't become a way to run anything else.
set -euo pipefail
usage() { echo "usage: scripts/test-lock.sh test|e2e|visual [args...]" >&2; exit 2; }
[ $# -ge 1 ] || usage
command -v flock >/dev/null || { echo "test-lock: flock is required (util-linux)." >&2; exit 1; }
case "$1" in
  test) script=test ;;
  e2e) script=test:e2e ;;
  visual) script=test:visual ;;
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
# Prints its arguments and appends them to the log. A log that can't be written is reported at the
# end; it never changes the tests' exit status.
logged=yes
say() { printf '%s\n' "$@" | tee -a "$log" || logged=no; }
# HEAD, tracked changes and untracked files that aren't ignored, by content. Ignored inputs
# (.dev.vars, node_modules, build output) aren't compared, and the log says so.
state() {
  {
    git rev-parse -q --verify HEAD || echo "no commit"
    git status --porcelain
    git diff --binary HEAD 2>/dev/null || true
    git ls-files -o --exclude-standard -z | xargs -0 -r sha1sum 2>/dev/null || true
  } | sha1sum | cut -d' ' -f1
}
# The lock is held from here to this script's exit. What the run covers is read only once it is
# held: a commit or an edit made during the wait for the lock would make an earlier reading wrong.
exec 9>"$locks/$database.lock"
flock 9
# A repository with no commit yet still runs: its result covers no commit.
head=$(git rev-parse -q --verify HEAD || echo "no commit")
changes=$(git status --porcelain)
before=$(state)
say "test-lock: pnpm $script $* at $head"
if [ -n "$changes" ]; then
  say "test-lock: at the start the working tree differs from $head, so this result covers no commit:" "$changes"
else
  say "test-lock: at the start the working tree matches $head (ignored files not compared)"
fi
# The tests' own exit status, kept apart from tee's.
set +e
pnpm "$script" "$@" 2>&1 | tee -a "$log"
results=("${PIPESTATUS[@]}")
set -e
status=${results[0]}
[ "${results[1]}" = 0 ] || logged=no
# Compared at the start and now, not watched in between.
if [ "$(state)" = "$before" ]; then
  say "test-lock: after the run, HEAD and the compared files are as they were at the start"
else
  say "test-lock: HEAD or the compared files changed during the run, so this result covers no single state"
fi
if [ "$logged" = yes ]; then
  say "test-lock: tests exit $status at $head, full output in $log"
else
  echo "test-lock: tests exit $status at $head"
  echo "test-lock: the log $log couldn't be written or is incomplete; that isn't a test result." >&2
fi
exit "$status"
