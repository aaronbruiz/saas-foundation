#!/bin/bash
# R12 timing helper: time-runs.sh <label> <runs> <cmd...> prints wall seconds and max RSS per run.
label=$1; n=$2; shift 2
out=$(mktemp)
for i in $(seq "$n"); do
  /usr/bin/time -f "%e %M" -o "$out" "$@" >/dev/null 2>&1; rc=$?
  echo "$label run$i rc=$rc wall=$(cut -d' ' -f1 "$out")s maxrss=$(cut -d' ' -f2 "$out")KB"
done
rm -f "$out"
