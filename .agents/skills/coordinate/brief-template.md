# <slug>: <task>

<!-- At most 40 lines. Rewrite this file, never append. Lives in .local/tasks/<slug>.md: the branch with `/` as `-`, or a short name until a branch exists (the brief then says it's pending, which is no permission to start).
Copy state from Git, the PR and CI, and say when you read it; those three win over this file. -->

Observed: <date and time>
PR: <number or none> · Branch: <branch> · Worktree: <path> · Owner: <task-owning session; a session id may identify it>
Base: <sha> · Head: <sha> · Status: <merged / validated / deployed / operational, or in progress>
Approved: <owner>, <time>, <scope>, <where said> / pending / not required (<why>)
<!-- The time is the owner's message timestamp or their own statement, never your clock or the PR's time; if you can't see it, say so and ask. A filename, folder or status label is never approval. -->

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
