# Roadmap

Owner-approved 2026-10-19. This file sets priorities. Session handoffs only resume the milestone marked current here; they don't choose the next one. Change this file only with the owner's approval.

Details live in the ADRs (`docs/adr/`) and runbooks (`docs/runbooks/`). This file links to them and doesn't copy their backlogs.

## Where we are (2026-10-19)

- **Production:** app-v0.3.2 (`dbd38b7`, released 2026-10-14). It connects as `app_owner`. It holds only smoke-test accounts (ADR-0014 data gate; ADR-0032 not lifted).
- **Merged, not released:** 31 commits on `main` (`caa9715`). They include migrations 0005–0008 (runtime role, archive/audit, hashed reset identifiers, webhook definer), ADR-0040 phases 1–2 (`GuardedClient`, tenant transactions) and atomic organization deletion. None has run in hosted CI.
- **Not operational:** GitHub Actions has started no billable job since 2026-10-15. Diagnosed 2026-10-20 from GitHub's billing API: the account is on the Free plan, and October's included Linux minutes are used up (2,078 minutes, all in this repository, $0 charged). Every job since then fails unstarted with GitHub's "payments have failed or your spending limit needs to be increased" annotation. Scheduled backups, the heartbeat (ADR-0037), CI, previews and the release workflow are all stopped. One manual backup ran on 2026-10-18.

## Status vocabulary

Merged, validated, deployed and operational are different states. Report each one separately.

| State           | Means                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Merged**      | On `main`. Local checks and review passed.                                                                                      |
| **Validated**   | Hosted CI passed on that exact commit, and anything that depends on the platform (Hyperdrive, Neon, Polar) was exercised there. |
| **Deployed**    | That validated artifact serves production traffic. It's the release tag, not whatever `main` is at the time.                    |
| **Operational** | Running unattended in production with working detection: scheduled jobs succeed, and a failure alerts someone.                  |

## Milestones

### M1: Verified release and operations restored (current)

- **Outcome:** production runs a verified release that contains the merged work (0005–0008, ADR-0040 phases 1–2). Backups, alerting and CI run unattended again.
- **Why:** 31 commits wait unreleased, and they include a new connection layer that has never run through Hyperdrive. The batch gets riskier every day it waits. Without backups, pilot data can't be admitted.
- **Before it starts:**
  - Find the actual cause of the Actions block from GitHub's billing data. A monthly reset may not fix it.
  - The owner authorizes any spending.
- **Done when:**
  1. **Hosted CI** passes on the release candidate's exact commit. #151's mandatory checks pass too: a pull request run, a deliberately drifted commit failing, and the first push-to-main run.
  2. **Hyperdrive behaviour validated** on that commit through a real Worker → Hyperdrive → Neon, using ADR-0040's preview checks (a)–(c) and (e): transaction-local context, rollback, the guard's status reads, no cache crossing between tenants. Check (d), latency, is measured in the same run if possible. It's required before M2.
  3. **Backups operational, with evidence in three parts:**
     - (i) two consecutive scheduled backup runs succeed and the heartbeat receives their pings (success path);
     - (ii) a controlled heartbeat test shows a missed or failed backup sends an alert, and recovery clears it (alert path);
     - (iii) the runbook's restore check passes on the latest dump.
  4. **Release** done per ADR-0029 and the runbook ("Releases"):
     - preflight, including `check-secrets --deployed`;
     - a fresh restore point;
     - migrations 0005–0008, then the 0% candidate, smoke test and promotion;
     - the rollback target version recorded.
  5. Production verified after the release: health, smoke e2e, and the definer function's privileges ("After a restore or a promote").
- **Deferred:** the runtime-role switch (M2), RLS policies (M4), and anything in the M5 backlog.

### Parallel track: Reuse validation

Owner-approved 2026-10-20. It runs while M1 is blocked on GitHub Actions. When hosted runs are available again, M1 takes priority and this track pauses wherever it stands.

- **Question:** starting from a fresh copy, can someone build and run a small SaaS locally using the documented paths, without undocumented knowledge from this project's authors?
- **Product:** a fictional client request tracker. Synthetic data only.
- **Bounded workflow:**
  - create a request;
  - add a comment;
  - change the request's status;
  - an open-request limit, enforced per plan;
  - tenant isolation proven by cross-tenant tests.

  Out of scope: attachments, notifications, search and custom statuses.

- **Who builds it:** a fresh agent. It gets the repository, `docs/runbooks/start-new-product.md` and `AGENTS.md`, and may explore the source normally. It records each friction point and workaround, and classifies the guidance it used: a documented instruction, reasonable discovery, or missing guidance. Reading source doesn't count as a failure by itself. A walkthrough by the owner afterwards strengthens the result.
- **Isolation:**
  - a disposable local copy with no git remote;
  - its own database service, port and volume;
  - synthetic credentials only;
  - no cloud resources, no deployments, and no access to production, the preview project or the main workspace's database.
- **Findings stay separate from fixes:** the agent doesn't change this repository. The owner reviews its ranked findings before any fix PR is opened. Each fix addresses only friction the exercise found, and none weakens an invariant or an ADR guarantee.
- **Done when:**
  - the flow works locally and its relevant checks pass (`pnpm check`, `pnpm test`, including the new cross-tenant tests);
  - a short friction report backed by evidence exists: time to the first working flow, manual steps, missing guidance, duplicated configuration, and problems the checks caught versus problems nothing caught.

  If the timebox (about two sessions) ends before the flow works, the report is still delivered and records where the flow stopped.

- **Feeds M3:** the pilot tests what this track found easy or hard.

### M2: Production on the least-privilege runtime role

- **Outcome:** production's Hyperdrive config connects as `app_runtime`, so ADR-0038's grants apply in production.
- **Why:** M1 deploys the role, but it protects nothing until production uses it. This switch is worth doing without RLS: least privilege stands on its own.
- **Before it starts:**
  - M1 done.
  - ADR-0040 decisions 7–8 and its staged rollout table, plus the runbook "Runtime role (ADR-0038)", revised in an owner-approved docs PR. Today they tie the G3/G4 switch to RLS enforcement. The revision separates the two: the role switch first, policies later.
  - ADR-0040 check (d), preview latency, recorded.
- **Done when:**
  - ADR-0038 G3 passes: effective privileges through Hyperdrive, plus the Neon default-ACL and effective-role checks in the runbook.
  - G4: owner approval recorded.
  - The switch is made and recorded.
  - Smoke e2e passes as `app_runtime`.
  - The way back to `app_owner` is documented and ready.
- **Deferred:** RLS policies and enforcement (M4).

### M3: Allowlisted pilot

- **Outcome:** a small allowlisted group uses the foundation for a defined use case. The pilot checks that sign-up, organizations, invitations, the tenant domain and sandbox billing work for real users, not only for smoke tests.
- **Why:** this is the first evidence that the foundation is usable, not only safe.
- **Before it starts:**
  - M1 and M2 done.
  - The pilot's use case and success criteria written down before anyone is admitted.
  - ADR-0032 step 1's Polar date checks, both ticked in the runbook ("Before production go-live"). Cancellation at period end was ticked on 2026-10-14, by moving the period end forward rather than waiting for the 2026-10-30 date that ADR-0032 still names. Failed renewal is still open; it's due after 2026-10-21 06:19 UTC. Ticking it completes step 1 but doesn't make the pilot ready on its own.
- **Done when:**
  - ADR-0032 rollout steps 2–7 are recorded.
  - The admitted users have exercised the defined use case.
  - The outcome is measured against the success criteria.
  - Operations stayed operational throughout.
- **Deferred:** opening sign-up (`SIGNUP_MODE=open`, its own ADR), live Polar billing, and features beyond the pilot's use case.

### M4: RLS reassessment

- **Trigger:** M4 starts before the first of these happens, not after it:
  1. opening self-service sign-up (`SIGNUP_MODE=open`, which needs its own ADR, ADR-0014);
  2. admitting users beyond the cohort written down in M3's pilot definition, or admitting users the owner doesn't know;
  3. adding a tenant-owned table, or a column on one, that holds tenant-sensitive data: personal data beyond account identity, customer content or files, credentials or secrets, or payment details.

  The existing tenant tables (`project`, `billing_subscription`) and the M3 pilot as defined don't trigger M4 by themselves. Allowlisted users still get tenant isolation from the application layer: AGENTS.md invariants 1–5 and the cross-tenant tests stay mandatory for every change, whether or not RLS is enforced.

- **Outcome:** a recorded decision to enforce RLS (ADR-0040 phases 3–5), or not to yet.
- **Before it starts:** M2 done, and ADR-0040 phase 1 live and stable in production.
- **Done when:** ADR-0040's enforcement acceptance criteria 1–4 are met and recorded, including the phase 3 gate (a test that `relforcerowsecurity` is false, and the conflict behaviour tested as `app_runtime` with the real policies). Or the decision not to proceed is recorded, with its reason.
- **Deferred:** any simplification of `GuardedClient`. It's considered only with evidence of its cost and an alternative that keeps its guarantees: nesting, concurrent use of one connection, and statements escaping a transaction.

### M5: Hardening backlog (deferred)

These items wait here until a milestone needs them. Each one is pulled in by a reason recorded in that milestone, never because a review found something to add. Examples:

- more depth in the schema/catalog gate (#151);
- further `GuardedClient` or lint hardening;
- session-token fingerprint and audit-retention work (ADR-0039);
- pgAudit;
- remaining research topics;
- IaC.

## Engineering rules while this roadmap holds

- **Frozen:** new RLS implementation, new security ADRs, `GuardedClient` hardening, and expansion of the schema gate. An exception needs a finding that is proven and within the current milestone's scope.
- **No rework during stabilization:** `GuardedClient` and the other merged controls stay as they are during M1–M2. Fix only proven defects.
- **When a review is done:**
  - By default, one review, then one review of the corrections.
  - Further rounds only while a material, in-scope finding is unresolved, or when a fix changes behaviour enough to need its own review.
  - Proven blockers within scope are always fixed.
  - Speculative findings, or findings outside the threat model, go to the M5 backlog with a note. They don't trigger another round.
- **Owner authorization:** every production deployment, database change, cloud resource creation and spending decision needs the owner's explicit approval.

## Planning cadence

| When                               | Question                                                           |
| ---------------------------------- | ------------------------------------------------------------------ |
| After each meaningful PR           | Did it finish the intended task, and nothing beyond it?            |
| After each milestone               | Are we still solving the most important problem? Update this file. |
| Before another architectural phase | Is it needed now, and what outcome justifies its cost?             |
