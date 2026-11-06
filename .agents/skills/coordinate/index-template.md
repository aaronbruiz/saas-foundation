# Session index

Selected task: <link to its brief, or none>

<!-- About 80 lines. Lives in .local/index.md. It's the owner's index, not state: no task state, no SHAs.
Task state is in Git, the PR and CI, then in .local/tasks/<slug>.md. Each fact lives in one place: a row links to its brief, PR or follow-up and gives the next action only.
Backlog that isn't a task yet goes in .local/tasks/follow-ups.md, each item under a stable `[slug]` that stays when it becomes tasks/<slug>.md; link items by slug.
Edit this file and follow-ups.md only under a lock: `mkdir .local/.lock` (fails if held), write your session id to .local/.lock/owner, reread, edit, `rm -r .local/.lock`. A lock older than 30 minutes whose owner isn't active may be removed; say so in the log.
Move older log entries to a monthly archive file. -->

## Active tasks

- [<slug>](tasks/<slug>.md): <next action>

## Decisions waiting for the owner

- <question> (<link to the PR, issue, brief or follow-up `[slug]`>)

## Accepted exceptions

- <exception>: <where it's recorded, when it's revisited>

## Log

- <date>: <what this session did, one line>
