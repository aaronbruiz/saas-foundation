# ADR-0036: Recovery objectives (RPO and RTO) and how they're measured

Status: Proposed · Date: 2026-10-15

## Context

Recovery paths exist for code ([ADR-0029](0029-releases-deploys-and-rollback.md) rollback) and data (Neon's 6 h point-in-time restore and daily snapshot branches, [ADR-0003](0003-neon-postgres-via-hyperdrive-drizzle.md); daily off-provider dumps to R2, [ADR-0023](0023-off-provider-database-dumps-to-r2.md)), but no document says how much data loss or downtime they're meant to bound. Before real pilot data ([ADR-0032](0032-lift-the-data-gate-allowlisted-pilot.md)), the owner wants stated targets that the evidence supports.

Evidence (recovery-readiness research R02, kept outside the repository; drill results in the runbook and in ADR-0029's Notes, 2026-10-15):

- **Execution is fast.** Drilled 2026-10-15: app rollback through `rollback.yml` 49–70 s; docs and site rollback 45–60 s; Neon point-in-time restore 2–6 s; selective copy 9–11 s and promote 2–3 s for a small table; a "Neon lost" rebuild on disposable infrastructure healthy in 59 s; a local dump restore in about 3 s at today's 28 KB.
- **Copies are daily, and their spacing drifts.** The `db-backup.yml` cron (04:23 UTC) starts 5.2–7.8 h late. Since the `needs: snapshot` workaround (2026-10-05), the gap between completed copies has been at most 25.3 h (median 23.9 h). Before it, a job stalled for 65.6 h and the dump gap reached 89.2 h, unnoticed until someone looked.
- **Detection is partial.** Workers Issues alerts on app errors ([ADR-0031](0031-production-alerting-issues-to-slack.md)). Nothing alerts on a stale backup: a stuck run sends nothing until it ends.
- **Response is one person.** The owner is the only operator.
- **Minutes are capped.** GitHub Actions has no payment method and no budget (owner 2026-10-15), so every workflow must fit the 2,000 included minutes a month. Dumps every 3 h (the cadence an RPO of 6 h would need) cost about 217 more minutes a month; October already used 2,044.

## Decision

1. **Scope.** Bad releases (code), data damage noticed within Neon's 6 h window, data damage noticed later, and the loss of the Neon project or account. A provider-wide Neon outage is **out of scope** (owner 2026-10-15); a fallback Postgres host would need its own research and ADR.
2. **The RTO clock runs from the incident's start to a verified recovery.** Reported with it, never in place of it: execution time (what drills measure) and detection-to-recovery.
3. **Targets:**

   | Scenario                                                | RPO                                                                                                                                                                                                             | RTO (execution)                                                                                                                                                       |
   | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Bad release, code only                                  | 0                                                                                                                                                                                                               | ≤ 1 h (drilled: about 1 min)                                                                                                                                          |
   | Data damage noticed within 6 h                          | Point-in-time restore to just before the damage: a full rollback also loses the valid writes made between the damage and the recovery. Selective recovery can lose less, once a reconciliation procedure exists | ≤ 1 h                                                                                                                                                                 |
   | Data damage noticed later; Neon project or account lost | **≤ 24 h** of copies: the newest snapshot or dump at the incident, plus, for a full rollback, the writes until recovery                                                                                         | ≤ 1 h. The rebuild's production-only steps (repointing production's Hyperdrive, new `NEON_PROJECT_ID` and `NEON_API_KEY`) are listed in the runbook but not yet timed |

4. **The 24 h RPO is a target with known breach risk, not a guarantee.** The cron's start delay alone produced a 25.3 h gap in normal operation. A gap above **32 h** (a day plus the observed delay) counts as a breach and should alert once backup-freshness detection exists (next item); until then it is found only by looking.
5. **Detection comes next.** Backup freshness gets an alert independent of GitHub's run notifications (a heartbeat pinged at the end of a successful dump), under its own short ADR after a security review of the monitoring service. It uses no Actions minutes.
6. **No bound on response.** The owner responds on a best-effort basis (owner 2026-10-15). So the full RTO, from incident to recovery, is **not bounded**; the 1 h figures above cover execution only.
7. **Re-drill** a recovery path whenever its scripts, credentials or the Neon plan change; roll the docs Worker back once a quarter (the cheapest live check of the per-Worker rollback).
8. **6 h stays the goal.** Revisit the cadence (dumps every 3 h in one job, hour-stamped names, a restore check in the same job) when the minutes allow it: CI time freed elsewhere, or a payment method.

## Alternatives

| Option                                     | Why not                                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPO ≤ 6 h now (dumps every 3 h)            | About +217 Actions minutes a month with no payment method; when Actions stops, backups and rollbacks stop with it                                                                                       |
| RPO ≤ 12 h (dumps every 12 h)              | About +30 minutes a month, but copy spacing still drifts by the cron delay, so a 12 h target would breach often; the owner chose 24 h now and 6 h as the goal                                           |
| More snapshots a day                       | Snapshots are branches: Neon Free allows 10 per project, with `main`, three daily snapshots and restore points already counted                                                                          |
| A bound on response time (e.g. 45 min ack) | A single owner can't promise it at all hours; stating one would make the RTO look bounded when it isn't                                                                                                 |
| Neon Launch (longer history window)        | Gives a more precise restore point for late-noticed damage but doesn't keep later writes; [ADR-0026](0026-neon-plan-capacity-and-upgrade-trigger.md)'s trigger already decides when production upgrades |

## Consequences

- ADR-0003's "noticed up to ~3 days later" for snapshots stays true; for anything Neon itself can lose, the dumps (ADR-0023) now carry the stated 24 h target.
- ADR-0023's cadence is unchanged. Its assumption that a failed run surfaces as GitHub's failed-workflow email doesn't cover a stuck run; the heartbeat ADR (decision 5) addresses that.
- The privacy text's backup wording doesn't change (no new cadence).
- Every claim above is tied to a drill or a measured history. When a recovery path changes, its numbers here go stale until it's re-drilled (decision 7).
