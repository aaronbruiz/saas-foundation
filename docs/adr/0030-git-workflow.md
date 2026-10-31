# ADR-0030: Git workflow: trunk-based, squash-merged Conventional PRs, specs in the PR

Status: Accepted (owner 2026-10-13) · Date: 2026-10-13

Writes down the workflow the repo already follows and adds the settings and checks that make it reliable enough for release automation ([ADR-0029](0029-releases-deploys-and-rollback.md) reads commit titles to decide releases). Extends [ADR-0012](0012-claude-implements-codex-reviews.md). Research and sources: `.local/research/releases-and-git-workflow.md` (2026-10-13; git-ignored, kept by the owner).

## Context

- One owner and two coding agents (Claude implements, Codex reviews; ADR-0012). The owner merges every PR.
- History on 2026-10-13: 81 linear, squash-merged commits. 80 of them have Conventional Commit titles (`fix(auth): …`), many with a scope. There are no tags, no release branches and no branch protection.
- Repo settings today: squash, merge-commit **and** rebase merges allowed; `squash_merge_commit_title: COMMIT_OR_PR_TITLE` (a single-commit PR lands with its commit's title, not the PR title); `squash_merge_commit_message: COMMIT_MESSAGES`; branches aren't deleted after merge.
- **The repo is private on GitHub Free.** Rulesets and branch protection are refused (API: 403 "Upgrade to GitHub Pro or make this repository public"). Environment required reviewers need Enterprise on private repos, so Pro wouldn't add them either. Environments with deployment-branch policies, which GitHub documents as Pro and up for private repos, work on this repo (ADR-0013's check; `db-backup.yml` reads `production` secrets).
- Every same-repo PR gets a preview with its own Neon branch, and the preview project has 10 (ADR-0021). Dependabot already holds up to 3 open PRs.
- A stacked child PR was **closed** when its base branch was deleted (#38); retargeting through the API works.
- "Spec-driven development" and "behaviour-driven development" were raised. They're ways of working, not branching models, and are decided separately below.

## Decision

### 1. Trunk-based development

- `main` is the only long-lived branch. Work happens on short-lived branches named `<type>/<scope>-<description>` (`feat/billing-annual-plans`, `docs/adr-0030-git-workflow`), merged within about two days.
- **No release branches.** Fix forward on `main`. In an emergency, roll back first (ADR-0029), then fix forward. If a hotfix ever must skip unreleased work on `main`, branch from the release tag at that moment; nothing is branched in advance.
- **Stacked PRs** are allowed, at most 3 deep, each a reviewable step. A stack is kept up to date by merging the base into the child (no rebase and force-push), and a child is retargeted with `gh api -X PATCH …/pulls/N -f base=main`, never by deleting its base branch.

### 2. Squash merges with Conventional PR titles

- **Squash merge only.** Merge-commit and rebase merges are turned off.
- **Squash commit title = the PR title** (`squash_merge_commit_title: PR_TITLE`), **message blank** (`squash_merge_commit_message: BLANK`). The `(#N)` suffix links each commit on `main` to its PR, where the spec and review live. A blank body also keeps release tooling from reading an agent's intermediate commit lines as extra changes.
- **The PR title is a Conventional Commit**, checked in CI on `pull_request` (so it also runs on release PRs, ADR-0029):
  - types: `feat`, `fix`, `perf`, `refactor`, `revert`, `docs`, `test`, `chore`, `ci`, `build`;
  - scope optional, lowercase; header at most 100 characters;
  - `!` after the type or scope marks a breaking change. For this product that is mainly a **contract migration** (ADR-0029 decision 7).
  - The check is an inline shell regex in its own workflow, `pr-title.yml`, which also runs when the PR is `edited`, so a corrected title is re-checked without re-running CI. No third-party action. Intermediate commits on a branch aren't linted: only the title reaches `main`.
- **Branches are deleted after merge** (`delete_branch_on_merge: true`). Because #38 showed that a deleted base branch can close a child PR, auto-delete is turned on only after a throwaway 2-deep stack confirms that merging the base retargets the child instead of closing it. If it doesn't, auto-delete stays off and stacks keep the manual retarget.

### 3. Specs in the PR (spec-driven development)

- Non-trivial work starts from a written spec before code. The spec is the PR description, in four parts: **Goal**, **Behaviour** (what a user or caller observes, including the failure cases), **Out of scope**, **Checks** (commands run and their results). A PR template provides the headings.
- Work that makes an architectural choice also gets an ADR in the same PR (AGENTS.md).
- Exploration and grilling notes stay outside the repo (`.local/`); what matters lands in the PR description or the ADR.

### 4. Tests named as behaviour (behaviour-driven development, lightly)

- Tests are named for the behaviour they prove, in the user's or caller's terms: "a non-member gets 404 on another tenant's overview" (#82), not "test getTenantContext".
- No Gherkin, no Cucumber and no `.feature` files: the reader of tests is the owner and the agents, and a translation layer adds nothing for them.

### 5. What is enforced, and where

| Rule                                     | Enforced by                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Squash only; PR title as commit title    | repo settings                                                             |
| Conventional PR title                    | CI check (`pr-title.yml`)                                                 |
| CI green before merge; PR-only to `main` | **the owner**, at merge time (no branch protection on Free; see Deferred) |
| Branch names, stack depth, specs, naming | review (Codex and owner)                                                  |
| Release tags can't be moved or deleted   | immutable releases (available on Free; ADR-0029)                          |

## Alternatives

| Option                                                   | Why not                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitFlow, or release branches (Neon's storage repo model) | Built for maintaining several shipped versions at once. A SaaS runs one version, and release branches add merges and cherry-picks for nothing. trunkbaseddevelopment.com: high-cadence teams release from trunk and fix forward |
| Merge commits or rebase merges                           | Non-linear history, or one commit per agent step on `main`. Release tooling then reads every intermediate commit                                                                                                                |
| commitlint on every commit                               | With a `PR_TITLE` squash title only the title reaches `main`. Linting work-in-progress commits slows agents down and checks nothing that ships                                                                                  |
| `amannn/action-semantic-pull-request`                    | Works, but it's one more third-party action with repo access. Its recommended `pull_request_target` trigger doesn't fire on release PRs opened with `GITHUB_TOKEN`. An inline regex does the same job                           |
| Specs as committed files (`docs/specs/`)                 | They pile up and drift from the code. The PR description stays attached to the change it produced, and Codex and GitHub can both read it. A spec under `.local/` would be invisible to Codex, which reviews in a separate tree  |
| Full BDD (Gherkin)                                       | A translation layer between the spec and the test, with step definitions to maintain. Playwright and Vitest names already read as behaviour                                                                                     |
| Required scope in PR titles                              | Most titles have one; requiring it adds friction to small changes                                                                                                                                                               |

## Deferred

| Decision                                          | Options                                                                                                                                                                                               | Trigger                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub Pro** (owner: not now, 2026-10-13)       | Pro enables a ruleset on `main`: PR-only, required checks (`ci`, PR title), linear history, no force-push or deletion, owner bypass. It also puts environments on private repos on documented footing | any of: a second person or bot with write access; a merge that skipped red or missing CI; GitHub changing how environments or deployment-branch policies behave on Free private repos (the `main`-only fence that ADR-0013, ADR-0021 and ADR-0029 rely on); making the repo public |
| Native stacked-PR tooling (`gh stack`, git-spice) | adopt if stacks become routine                                                                                                                                                                        | a third stack in a month, or a retarget mistake                                                                                                                                                                                                                                    |

## Consequences

- `main`'s history becomes a reliable release input: one Conventional commit per PR, titled by a checked PR title.
- Without branch protection, the owner's merge is the only gate for "CI is green". The release PR (ADR-0029) is where that matters most, and CI must run there before merging.
- **The environment fence is undocumented on Free.** If GitHub starts enforcing its documentation, environment secrets may stop reaching jobs (deploys and backups fail) or deployment-branch policies may stop applying (the fence opens). Either one is the Pro trigger above, and the owner rechecks `db-backup.yml` and the deploy workflows when it happens.
- Up to 3 stacked PRs each hold a preview Neon branch. With Dependabot (up to 3) and the release PR (skipped by previews, ADR-0029), the preview project keeps headroom.
- Follow-up PR (after acceptance), owner-approved because it changes repo settings: set squash-only, `PR_TITLE` / `BLANK`, the PR-title check (`pr-title.yml`), a PR template, the throwaway-stack test and then auto-delete, and a "Git workflow" section in AGENTS.md.

## Notes (2026-10-13)

**Repo settings applied** by the owner: squash merge only, `squash_merge_commit_title: PR_TITLE`, `squash_merge_commit_message: BLANK` (#92 landed as `64bef87` with its PR title and an empty body), then `delete_branch_on_merge: true`.

**Stack test passed; auto-delete stays on.** Throwaway stack off `main`, never merged into it: `test/stack-root` ← #93 (`test/stack-base`) ← #94 (`test/stack-child`). With auto-delete on, squash-merging #93 deleted `test/stack-base`, and GitHub retargeted #94 to `test/stack-root` (timeline event `automatic_base_change_succeeded`, 18:42:31Z); #94 stayed open. #94 was then closed and the throwaway branches deleted. A child whose base is deleted any other way (manually, or before its PR merges) can still be closed, as #38 was. The `gh api … -f base=main` retarget stays the fallback.

## Notes (2026-10-30)

**When to reassess the PR description as the spec.** PR descriptions record behaviour per change, not per requirement: a product's current behaviour lives in its code, its tests and `docs/product/overview.md` (ADR-0041). These are reasons to reassess that choice, not to adopt a spec store automatically: a product with more than one implementing team, or a customer or regulator asking for requirement-to-test traceability. A reassessment is a new ADR that weighs a spec store and requirement IDs against today's PR-based records.

**Spec approval and the template (owner-approved).** The spec keeps its four parts. The rules are in AGENTS.md "Working rules": which PRs need the owner's approval of Behaviour before code, how an approved line is amended, and what wins on a conflict. A PR description is the spec until merge, then history. Goal opens with a plain-language sentence instead of a separate ELI5 section. Considered and declined: more required sections (constraints, implementation, risk, visual proof, AI disclosure: they restate rules, the diff or what ADR-0012 fixes), required behaviour IDs (tests carry no IDs, so they add no link to code), and a draft PR before code (it contradicts pushing once after a clean review, and an empty commit runs all of CI). Approval is recorded by text under one login shared with the agents, so the record guards against drift, not forgery.

**Ruleset declined.** The repository is now public, which is one of the triggers under Deferred. The owner declined a ruleset on 2026-10-30. "CI green before merge; PR-only to `main`" stays the owner's at merge time, with `scripts/merge-readiness.mjs` before it and `provenance.yml` detecting a violation after it.
