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

### M1: Verified release and operations restored (done 2026-10-29)

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
- **Result (2026-10-29, owner-reviewed):** done; app 0.4.0 (`c8d6a2a`) is live.
  1. Hosted CI passed on the candidate `c09bbf1` (run 39553353113) and on the released commit (push run 40817834758), which differs from it only by CI's workflow and an ADR-0021 note (#180). #151's checks on 2026-10-21: the schema gate passed on pull request runs (39553353113 and others), the deliberately drifted #179 failed at it (39554689817), and the first push-to-main run passed (39544050597).
  2. ADR-0040 checks (a)–(c) and (e) passed on a preview (ADR-0040 Notes, #182). (d) wasn't measured; it opens M2.
  3. (ii) passed: the heartbeat alerted on a failed ping and recovered. (iii) passed on an older dump: the runbook restore of the owner-supplied production dump of 2026-10-15 passed with the 0005–0008 replay and the definer check; the newest dump (2026-10-29) wasn't restored. (i) was waived by the owner for this release: the scheduled runs of 2026-10-21 to 10-28 never started (an Actions billing block while the repository was private), and a manual run on 10-29 succeeded with its heartbeat ping. Scheduled runs succeeding unattended is still to be confirmed.
  4. Release run: preflight, restore point `pre-migrate-app-v0.4.0-20261029T042822Z`, migrations 0005–0008, the 0% candidate (held because `wrangler.jsonc` differed only in a comment and the local connection string), then promotion. Rollback target: app-v0.3.2, version `0ef56ba5`.
  5. Health, the definer check and the identity check (G2: `app_runtime` with exactly ADR-0038's grants, no memberships) passed in production. The owner's smoke checklist (two accounts in separate tenants) passed except the project rename, which wasn't captured.

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
- **Result (2026-10-21, owner-reviewed):** done. A fresh session built the flow from the docs; `pnpm check`, `pnpm test` and `pnpm test:e2e` passed (the new e2e test alone, see below). The fixes the owner approved are documentation (child tables, first-feature walkthrough, regeneration commands, test troubleshooting, ADR-0040's partial acceptance) and `pnpm db:check` without `origin/main`. Follow-ups:
  - E2E sign-ins: the existing suite nearly uses up the login rate limit, so one more test that signs in fails the full run. Shared signed-in fixtures, keeping real sign-in in the tests about it. ADR-0005 rules out a test exemption from the limit.
  - ADR-0038 and ADR-0039 are Proposed while AGENTS.md treats their grants and archive triggers as binding; reconcile their status the way ADR-0040's was.
  - Optional (M5): a catalog test that discovers tenant-owned tables and checks each one's grant, archive trigger and registration, instead of the hand-kept lists.

### M2: Production on the least-privilege runtime role (done 2026-10-29)

- **Outcome:** production's Hyperdrive config connects as `app_runtime`, so ADR-0038's grants apply in production.
- **Why:** M1 deploys the role, but it protects nothing until production uses it. This switch is worth doing without RLS: least privilege stands on its own.
- **Before it starts:**
  - M1 done.
  - ADR-0040 decisions 7–8 and its staged rollout table, plus the runbook "Runtime role (ADR-0038)", revised so the role switch comes first and policies later (done: owner-approved docs PR, 2026-10-21).
  - ADR-0040 check (d), preview latency: not measured in M1, so it's M2's first task, and it's recorded before the production switch (done 2026-10-29: create-and-refresh +46 ms p50 at the 50 ms threshold; owner: material, switch anyway; ADR-0040 Notes).
- **Done when:**
  - ADR-0038 G3 passes: effective privileges through Hyperdrive, plus the Neon default-ACL and effective-role checks in the runbook (done 2026-10-29).
  - G4: owner approval recorded (done 2026-10-29).
  - The switch is made and recorded (done 2026-10-29, 14:02Z; runbook "Runtime role (ADR-0038)" step 5).
  - Smoke e2e passes as `app_runtime` (done 2026-10-29: owner's manual smoke, as for M1, plus `/api/health` and an hour without `42501`).
  - The way back to `app_owner` is documented and ready (`hd_point app_owner`, runbook).
- **After the switch (owner, 2026-10-29):** reopen ADR-0040 decision 8's cost, per-request contexts (design B) or batching, because check (d) found it material. Start with the decision; the stabilization rule below still holds until the owner approves a change. Decided 2026-10-29: consolidate calls on create-and-refresh, with no `GuardedClient` change (ADR-0040 Notes). Done in #189 (`cf6d01b`); re-measured on a preview on 2026-10-29 (ADR-0040 Notes). Create-and-refresh: paired saving about 25 ms (the median of the five per-run paired p50s; pooled, 23 ms; neither is the difference of the aggregate medians); the new path's added cost is 30 ms, below its 50 ms threshold.
- **Result (2026-10-29, owner-reviewed):** done. Since 14:02:30Z production's Hyperdrive config connects as `app_runtime` (runbook "Runtime role (ADR-0038)" record: G1–G4, identity check, the owner's smoke, an hour without `42501`); the way back is `hd_point app_owner`. Decision 8's follow-up, #189, is measured above. Navigation's 26 ms runs are carried to M3 as an open observation.
- **Deferred:** RLS policies and enforcement (M4).

### M3: Allowlisted pilot (current; deferred 2026-10-29)

- **Deferred (owner, 2026-10-29):** no participants are available. It isn't done. Meanwhile the owner approved two items: the "E2E sign-ins" follow-up of the reuse-validation track above and the failed-renewal check below.
- **Outcome:** a small allowlisted group uses the foundation for a defined use case. The pilot checks that sign-up, organizations, invitations, the tenant domain and sandbox billing work for real users, not only for smoke tests.
- **Why:** this is the first evidence that the foundation is usable, not only safe.
- **Before it starts:**
  - M1 and M2 done.
  - The pilot's use case and success criteria written down before anyone is admitted.
  - ADR-0032 step 1's Polar date checks, both ticked in the runbook ("Before production go-live"). Cancellation at period end was ticked on 2026-10-14, by moving the period end forward rather than waiting for the 2026-10-30 date that ADR-0032 still names. Failed renewal was ticked on 2026-10-29 (the subscription canceled on 2026-10-21; runbook). That completes step 1 but doesn't make the pilot ready on its own.
- **Done when:**
  - ADR-0032 rollout steps 2–7 are recorded.
  - The admitted users have exercised the defined use case.
  - The outcome is measured against the success criteria.
  - Operations stayed operational throughout.
- **Open observation (from M2, owner 2026-10-29):** the navigation path's added cost, threshold 25 ms p50 (ADR-0040 check (d)). The re-measurement after #189 (2026-10-29, which didn't change navigation) gave 20/22/22/26/26 ms per run: median 22, 2 of 5 runs over. Check (d) had given 15–25 ms, 0 of 9 over. The cause isn't established; that session's base round trip was also higher. It's unresolved, not dismissed as noise: settle it with evidence, for example a repeat navigation measurement during the pilot. It isn't a pilot gate unless the owner makes it one.
- **Deferred:** opening sign-up (`SIGNUP_MODE=open`, its own ADR), live Polar billing, and features beyond the pilot's use case.

### M4: RLS reassessment

- **Trigger:** M4 starts before the first of these happens, not after it:
  1. opening self-service sign-up (`SIGNUP_MODE=open`, which needs its own ADR, ADR-0014);
  2. admitting users beyond the cohort written down in M3's pilot definition, or admitting users the owner doesn't know;
  3. adding a tenant-owned table, or a column on one, that holds tenant-sensitive data: personal data beyond account identity, customer content or files, credentials or secrets, or payment details.

  The existing tenant tables (`project`, `billing_subscription`) and the M3 pilot as defined don't trigger M4 by themselves. Allowlisted users still get tenant isolation from the application layer: AGENTS.md invariants 1–5 and the cross-tenant tests stay mandatory for every change, whether or not RLS is enforced.

- **Outcome:** a recorded decision to enforce RLS (ADR-0040 phases 3 and 5; phase 4 is M2's switch), or not to yet.
- **Before it starts:** M2 done, and ADR-0040 phase 1 live and stable in production.
- **Done when:** ADR-0040's acceptance criteria 1–4 for the phase 3 release are met and recorded, then its post-release production checks, including the phase 3 gate (a test that `relforcerowsecurity` is false, and the conflict behaviour tested as `app_runtime` with the real policies). Or the decision not to proceed is recorded, with its reason.
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
