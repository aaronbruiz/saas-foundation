# ADR-0042: Tracked agent workflows (skills), starting with the Codex review

Status: Accepted (owner 2026-10-30) · Date: 2026-10-30

## Context

Agent skills are folders with a `SKILL.md` (name, description, instructions) that an agent discovers and runs on request. Until now this repository tracked none: `.claude/skills/` and `.agents/` were git-ignored per-machine links, filled by each machine's setup (`setup_skills.sh --local` treats `<project>/.agents/skills` as the store and links each skill into `.claude/skills/`).

The Codex review ([ADR-0012](0012-claude-implements-codex-reviews.md)) is repeated on every pull request and correction, but its procedure lived outside the repository: 187 review prompts and 172 correction prompts were written by hand (median about 2 KB, most with the same "check for, in priority order" shape), and a product cloned from this foundation inherited the rule but not the procedure. An assessment of an external spec-driven-development starter kit (2026-10-30) found its review, security-check and verification prompts useful as one repeatable workflow once their requirement IDs and spec store were removed (ADR-0030 keeps the PR description as the spec).

Discovery was tested on 2026-10-30 in a throwaway repository and a fresh clone of it:

- Codex (`codex exec`) found and ran a skill in `.agents/skills/<name>/SKILL.md` from `$<name>`, without reading the file through a tool.
- Claude Code didn't find a skill that existed only in `.agents/skills`. It found it through a link `.claude/skills/<name>` → `../../.agents/skills/<name>`, tracked by git as a symlink, in a fresh clone (listed at session start; `/<name>` ran it).
- A checkout with the old layout (`.agents/skills` a link to `../.claude/skills`, a personal skill in `.claude/skills/`) took the change with `git pull`: git replaced the ignored link with the real directory and the personal skill stayed.

## Decision

1. **The repository may track agent workflows as skills.** Each lives in `.agents/skills/<name>/SKILL.md` (the copy Codex reads) with a tracked symlink `.claude/skills/<name>` → `../../.agents/skills/<name>` (the copy Claude Code reads). `.gitignore` tracks exactly these names and keeps every other entry in both directories per-machine.
2. **Skills are procedures, not rules.** A skill says how to carry out a task and cites the rules it applies (AGENTS.md sections, ADRs); it never states a rule of its own or a different version of one. `AGENTS.md` stays the only rulebook ([ADR-0008](0008-agents-md-canonical.md)). A rule change goes to `AGENTS.md` or an ADR, then the skill's citation follows.
3. **First skill: `review-pr`**, the Codex review of ADR-0012: read-only scope, findings with locations and evidence, verified checks kept apart from checks not run, correction reviews. It never edits the reviewed code, approves or merges. Invocation, from a detached review worktree at the PR head:

   ```
   codex exec -C <worktree> -s read-only -o <result>.md "Use \$review-pr. Base origin/main. PR #<n>. Extra risks: …"
   codex exec -C <worktree> -s read-only -o <result>.md "Use \$review-pr for a correction review. Previous result: <file>. Corrections: 1) … 2) …"
   ```

4. **A new skill needs evidence of a repeated procedure** and is added by a PR that adds its link and the `.gitignore` exceptions for exactly its `SKILL.md` and that link. Candidates reviewed but not added: `feature-spec` (feature request → PR description drafts) and `product-rules` (drafting a product's `docs/product/AGENTS.md`, ADR-0041); they're tried on real product tasks first. A release-check skill waits for an identifiable manual gap in the release process (ADR-0029 automates its gates today).

## Migration of an existing checkout

Personal skills are kept; nothing needs deleting.

1. Nothing needs committing or stashing first: the old `.agents/skills` link and `.claude/skills/` are ignored, so `git pull` (or `git merge`) replaces the link with the real `.agents/skills/` directory and adds `.claude/skills/review-pr`. Personal skills in `.claude/skills/` stay where they are, and Claude Code keeps seeing them.
2. Codex saw personal skills through the old link. To keep that, link each one into the new directory (ignored there): `ln -s ../../.claude/skills/<name> .agents/skills/<name>`, or rerun `setup_skills.sh --local <repo>`, which installs its packs into `.agents/skills/` and links them into `.claude/skills/`.
3. A personal skill named like a tracked one (`review-pr`) is renamed first; the tracked one wins.
4. Check: `git status` is clean, `ls -l .claude/skills/review-pr` shows the link, and `codex exec … "Use \$review-pr …"` runs it.

## Alternatives

- **Workflow documents (`docs/workflows/*.md`)**: agent-neutral, but neither agent discovers them, so every use starts with "read this file first", today's friction.
- **Personal skills only** (`~/.agents/skills`): no repository change, but products and any second contributor don't get them, while ADR-0012's loop is repository policy.
- **The tracked copy in `.claude/skills/`, linked from `.agents/skills/`**: works equally for discovery, but `setup_skills.sh` already treats `.agents/skills` as the store, so the opposite direction would fight it.
- **Two copies, one per agent**: no symlink, but the copies drift.

## Consequences

- Products inherit `review-pr` through `git merge upstream/main`, like `AGENTS.md`.
- Symlinks need a checkout that keeps them (git's default on Linux and macOS). On Windows without symlink support the link becomes a small text file and Claude Code misses the skill; Codex still finds it.
- A PR that renames or removes an `AGENTS.md` section a skill cites updates the skill (Code Review Rules).
- When to revisit: Claude Code reading `.agents/skills` itself (the link can go), or a skill that turns out to need rules of its own (then the rule belongs in `AGENTS.md`).

## Notes (2026-10-30)

Owner-approved amendment to decision 4, for the Starting kit (`docs/roadmap.md`):

- `product-rules`, `feature-spec` and `coordinate` ship as a trial ahead of the evidence rule, because a product can't exercise them until they exist. The owner keeps, reworks or removes each after the first real product's first 3 PRs.
- `.claude/agents/worker.md` is tracked on the same terms: a procedure that cites the rules. `coordinate`'s limits and stop conditions are its own procedure, not repository rules.
- ADR-0012's loop doesn't change: each PR is still implemented by Claude, reviewed by Codex in a separate tree and merged by the owner.
