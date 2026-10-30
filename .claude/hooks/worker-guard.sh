#!/usr/bin/env bash
# PreToolUse(Bash) for the worker agent: workers commit, and the coordinator pushes, opens the PR and
# the owner merges. Matches the typed command, so it's a guard against mistakes, not a security boundary.
set -u
command -v jq >/dev/null || { echo "worker-guard: jq is required; install it (e.g. apt install jq)." >&2; exit 2; }
cmd=$(jq -r '.tool_input.command // ""') || { echo "worker-guard: could not parse the hook input." >&2; exit 2; }
W='(^|[^a-zA-Z0-9_./-])'
if grep -Eq "${W}git([[:space:]]+-[cC][[:space:]]+[^[:space:]]+)*[[:space:]]+push([[:space:]]|$)|${W}gh[[:space:]]+pr[[:space:]]+(create|merge)([[:space:]]|$)" <<<"$cmd"; then
  echo "Blocked: a worker doesn't push, open a PR or merge. Commit and report to the coordinator." >&2
  exit 2
fi
exit 0
