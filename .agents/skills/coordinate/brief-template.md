# <branch>: <task>

<!-- At most 40 lines. Rewrite this file, never append. Lives in .local/tasks/<branch>.md.
Copy state from Git, the PR and CI, and say when you read it; those three win over this file. -->

Observed: <date and time>
PR: <number or none> · Branch: <branch> · Worktree: <path> · Owner: <task-owning session; a session id may identify it>
Base: <sha> · Head: <sha> · Status: <merged / validated / deployed / operational, or in progress>

## Goal

<one or two lines>

## Behaviour this task owns

- <lines from the approved PR description; only an amendment changes them>

## Files

Owns: <paths>
Must not touch: <paths>
Integrator: <yes: migrations, contracts, generated files, lockfile, wrangler.jsonc / no>

## Risk

<tenant, auth, billing or migration / routine>

## Checks to run

- <commands, through scripts/test-lock.sh for tests>

## Stop and report when

- a change is needed outside the owned files
- two fix attempts have failed
- a policy question comes up, or a credential or production resource appears

## Result

Commit: <sha> · Checks: <command, result, commit> · Not run: <check, why>

## Open questions

- <question, who decides, what waits>
