#!/usr/bin/env bash
# One `pnpm test` or `pnpm test:e2e` at a time across this repository's worktrees: they share the
# `app_test` database and port 3000. It takes only these two commands, because agents may run it
# without a prompt (.claude/settings.json), so it mustn't become a way to run anything else.
set -euo pipefail
usage() { echo "usage: scripts/test-lock.sh test|e2e [args...]" >&2; exit 2; }
[ $# -ge 1 ] || usage
command -v flock >/dev/null || { echo "test-lock: flock is required (util-linux)." >&2; exit 1; }
lock="$(git rev-parse --git-common-dir)/test.lock"
case "$1" in
  test) shift; exec flock "$lock" pnpm test "$@" ;;
  e2e) shift; exec flock "$lock" pnpm test:e2e "$@" ;;
  *) usage ;;
esac
