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
# end; it never changes the tests' exit status. `tee -p` keeps writing the log and reading the
# tests' output when this script's own output is closed, so that can't end the tests either.
logged=yes
say() { printf '%s\n' "$@" | tee -a -p "$log" || logged=no; }
# No external diff, textconv or fsmonitor program: reading the state runs nothing a Git setting names.
status_now() { git -c core.fsmonitor=false status --porcelain --untracked-files=normal; }
# HEAD, the working tree's difference from it and the untracked files that aren't ignored, by
# content; fails when any of it can't be read. Not compared: ignored files (.dev.vars,
# node_modules, build output), the index apart from the working tree, files Git is told to assume
# unchanged, a nested repository's content, modes of untracked files. Two readings, not a watch.
state() {
  local base
  # No commit yet: the difference from the empty tree.
  base=$(git rev-parse -q --verify HEAD || git hash-object -t tree /dev/null) || return 1
  {
    echo "$base" &&
      status_now &&
      git diff --binary --no-ext-diff --no-textconv "$base" &&
      git ls-files -o --exclude-standard -z | xargs -0 -r sha1sum
  } | sha1sum | cut -d' ' -f1
}
# The lock is held from here to this script's exit. What the run covers is read only once it is
# held: a commit or an edit made during the wait for the lock would make an earlier reading wrong.
exec 9>"$locks/$database.lock"
flock 9
# A repository with no commit yet still runs: its result covers no commit.
head=$(git rev-parse -q --verify HEAD || echo "no commit")
before=$(state) || before=unknown
say "test-lock: pnpm $script $* at $head"
if ! changes=$(status_now); then
  say "test-lock: the working tree couldn't be read at the start, so this result covers no commit"
elif [ -n "$changes" ]; then
  say "test-lock: at the start the working tree differs from $head (ignored files not compared), so this result covers no commit:" "$changes"
else
  say "test-lock: at the start the working tree matches $head (ignored files not compared)"
fi
# The tests' own exit status, kept apart from tee's.
set +e
pnpm "$script" "$@" 2>&1 | tee -a -p "$log"
results=("${PIPESTATUS[@]}")
set -e
status=${results[0]}
[ "${results[1]}" = 0 ] || logged=no
after=$(state) || after=unknown
if [ "$before" = unknown ] || [ "$after" = unknown ]; then
  say "test-lock: HEAD and the compared files couldn't be read at the start or after the run, so whether they changed is unknown"
elif [ "$after" = "$before" ]; then
  say "test-lock: after the run, HEAD and the compared files are as they were at the start"
else
  say "test-lock: HEAD or the compared files changed during the run, so this result covers no single state"
fi
say "test-lock: tests exit $status at $head"
# Decided after the last write to the log. Through cat, so a closed output can't end this script
# before it exits with the tests' status.
if [ "$logged" = yes ]; then
  echo "test-lock: full output in $log" | cat || true
else
  echo "test-lock: the log $log couldn't be written or is incomplete; that isn't a test result." >&2 || true
fi
exit "$status"
