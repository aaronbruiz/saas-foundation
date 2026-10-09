#!/usr/bin/env bash
# PreToolUse(Bash): block unbounded polling, warn on hand-rolled process management.
# Only the typed command is inspected; project scripts run from files are not.
# Origin: a `pgrep -f` wait loop matched its own command line and never exited (~30 min lost, 2026-09-30).
set -u
# Fail closed: without jq (or with unparsable input) nothing could be checked.
command -v jq >/dev/null || { echo "block-poll-loops: jq is required; install it (e.g. apt install jq)." >&2; exit 2; }
raw=$(jq -r '.tool_input.command // ""') || { echo "block-poll-loops: could not parse the hook input." >&2; exit 2; }
cmd=$(tr '\n' ';' <<<"$raw")
has() { grep -Eq "$1" <<<"$cmd"; }

W='(^|[^a-zA-Z0-9_-])' # word start
loop="${W}(while|until)[[:space:]]"
infinite="${W}(while[[:space:]]+(true|:|\[[[:space:]]*1[[:space:]]*\])|until[[:space:]]+false)([[:space:];]|$)"
forever='for[[:space:]]*\(\([[:space:]]*;[[:space:]]*;'
# The only accepted bound: an outer `timeout N` that precedes the loop. Bounds written in shell
# logic (counters, attempt variables) aren't verifiable from text, so they don't count.
timeout_wrap="${W}timeout[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*[0-9][^;]*"
proc_check="${W}(pgrep|pidof|ps)[[:space:]]|kill[[:space:]]+-0|/proc/"

block() {
  cat >&2 <<EOF
Blocked unbounded polling ($1).
If you are waiting for a command you launched, run it with run_in_background and rely on its completion notification rather than polling.
If you are waiting for an external readiness condition, wrap the loop in an outer \`timeout N\` (e.g. timeout 60s bash -c 'until curl -fsS URL; do sleep 2; done') or use a finite \`for i in {1..N}\` loop.
EOF
  exit 2
}

has "${W}pkill[[:space:]]([^|;&]*[[:space:]])?-[a-zA-Z]*f" && block "pkill -f"
outer_timeout() { has "${timeout_wrap}($1)"; }
has "$forever" && ! outer_timeout "$forever" && block "infinite for loop without an outer timeout"
if has "$loop"; then
  has "$proc_check" && block "loop polling a process"
  has "$infinite" && ! outer_timeout "$infinite" && block "infinite loop without an outer timeout"
  has "${W}sleep[[:space:]]" && ! outer_timeout "$loop" && block "sleep loop without an outer timeout"
fi

warn=()
has "${W}pgrep[[:space:]]([^|;&]*[[:space:]])?-[a-zA-Z]*f" && warn+=("pgrep -f can match its own command line")
has "${W}(pkill|killall)[[:space:]]|kill[^;|&]*\\$\((pgrep|pidof)" && warn+=("process-name based lifecycle management; prefer an explicit PID")
has "${W}nohup[[:space:]]" && warn+=("nohup detaches the process from Claude Code")
has '(^|[^&>|])&[[:space:]]*($|;|\)|\})' && warn+=("trailing & detaches the process from Claude Code")
if ((${#warn[@]})); then
  msg="Discouraged: $(IFS=';'; echo "${warn[*]}"). If Claude Code can own this task, use run_in_background instead."
  jq -n --arg m "$msg" '{systemMessage: $m, hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $m}}'
fi
exit 0
