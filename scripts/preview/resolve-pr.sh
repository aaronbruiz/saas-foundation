#!/usr/bin/env bash
# The PR a preview run deploys (ADR-0021), for preview.yml and static-preview.yml: the one open
# same-repo PR whose head is exactly HEAD_SHA (an older commit's run is skipped), and only if it's
# the PR this run is locked for (LOCK_PR, from the workflow_run event). The number comes from
# GitHub, never from the run's branch name or artifact. Prints it, or nothing when the run skips.
# Usage: GH_TOKEN=… REPO=owner/name HEAD_SHA=<sha> LOCK_PR=<n> scripts/preview/resolve-pr.sh
set -euo pipefail
: "${GH_TOKEN:?}" "${REPO:?}" "${HEAD_SHA:?}"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "unexpected head sha" >&2; exit 1; }
# Checked assignment: a failing API call fails the run instead of skipping it.
prs="$(gh api "repos/$REPO/commits/$HEAD_SHA/pulls" | jq -r '[.[] | select(.state == "open"
  and .head.sha == env.HEAD_SHA and .head.repo.full_name == env.REPO
  and .base.repo.full_name == env.REPO) | .number]')"
count="$(jq length <<<"$prs")"
if [ "$count" != 1 ]; then echo "no single open PR at $HEAD_SHA ($count); skipping" >&2; exit 0; fi
pr="$(jq -r '.[0]' <<<"$prs")"
[[ "$pr" =~ ^[1-9][0-9]{0,6}$ ]] || { echo "unexpected PR number" >&2; exit 1; }
# This run holds the lock of LOCK_PR only: never touch another PR's resources.
if [ "$pr" != "${LOCK_PR:-}" ]; then
  # stderr: stdout is the result. The runner reads workflow commands from both streams.
  echo "::notice title=Preview skipped::this run isn't locked for PR #$pr (lock: '${LOCK_PR:-}')" >&2
  exit 0
fi
echo "$pr"
