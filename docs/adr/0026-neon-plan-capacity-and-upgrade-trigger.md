# ADR-0026: Neon plan for launch: Free's capacity limits and the upgrade trigger

Status: Proposed · Date: 2026-10-01

Answers launch milestone D's condition "Neon Free's capacity limits ([ADR-0003](0003-neon-postgres-via-hyperdrive-drizzle.md)) explicitly accepted or the plan upgraded" (runbook "First production deploy"). Revisits ADR-0003's amendment "Neon stays on the Free plan (2026-09-27)" with current prices and measured usage. The decision is the owner's.

## Context

**Neon plans** (Neon docs via Context7 `/neondatabase/website`: `docs/introduction/plans.md`, `public/pricing.md`, `docs/manage/orgs-project-transfer.md`; checked 2026-10-01):

|                  | Free                                                                | Launch                                                             |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Price            | $0                                                                  | usage only, **no monthly minimum**; invoices < $0.50 not collected |
| Compute          | **100 CU-hours per project per month**, up to 2 CU                  | $0.106/CU-hour, up to 16 CU                                        |
| Scale to zero    | after 5 min, **can't be disabled**                                  | after 5 min, **can be disabled**                                   |
| Storage          | **0.5 GB per project**                                              | $0.35/GB-month                                                     |
| Restore history  | **6 hours** (capped at 1 GB-month of changes)                       | up to 7 days (paid plans default to 1 day); $0.20/GB-month         |
| Egress           | **5 GB per project per month**                                      | 500 GB per project, then $0.10/GB                                  |
| Branches         | 10 per project                                                      | 10 per project, extra $1.50/branch-month                           |
| Snapshots        | 1 manual                                                            | 100 manual, scheduled; $0.09/GB-month (since 2026-05-01)           |
| Usage visibility | console only; consumption API refused (see below); 1-day monitoring | consumption API, **spending notifications**, 3-day monitoring      |

- **Exceeding a Free limit** (docs FAQ): out of CU-hours or egress → **the compute is suspended until the next billing period or until you upgrade**; over 0.5 GB → inserts, updates and deletes fail until space is freed or the plan upgraded; no data is deleted. Compute and egress reset each billing period; storage and branches are continuous limits.
- **Upgrading is a billing change, not a migration**: same connection string, data, branches, roles and Postgres version. So the Hyperdrive config, Worker and backup jobs don't change.
- **The plan belongs to the Neon organization**, not the project. A project can be **transferred** to another organization (console or API, needs Admin in the source org): credentials and connection string don't change, billing and limits follow the destination org's plan, which must be the same tier or higher; project integrations must be disconnected first.
- Scale ($0.222/CU-hour, 25 branches, configurable scale-to-zero, up to 30 days of history, SLA, SOC 2/HIPAA available) costs about twice Launch per CU-hour; nothing here needs it yet.

**Measured 2026-10-01** (read-only Neon CLI 6.3.0 and API GETs, owner-approved; no connection string read):

- Organization `Business` (`org-sparkling-cherry-73217784`): plan `free` (`free_v3`). It holds **five projects**: production `saas-foundation`, `saas-foundation-preview` (ADR-0011) and three unrelated to this repo. Upgrading this organization bills all five.
- Production project `flat-cherry-23373668`: one read-write compute, autoscaling **0.25–0.25 CU** (fixed at the minimum); `idle` at the check, last active 14:03:35Z, so it does suspend with Hyperdrive's pool in front of it. History 21,600 s (6 h). Billing period = calendar month (2026-10-01 → 2026-11-01).
- Storage: `main` logical size **31,825,920 bytes (≈ 30 MiB)** of the 536,870,912-byte (512 MiB) per-branch limit; synthetic storage the same. The 2026-10-01 dump is 28,047 bytes for 12 tables (runbook "Database"), so nearly all of the 30 MiB is Postgres's own baseline, not our data. The three `backup-*` snapshot branches are child branches with no writes of their own.
- **CU-hours: not measurable from here on Free.** The consumption API answers `403 "This endpoint is not available. It is included with Launch plans and above."`; the per-project counters in the API (`active_time`, `cpu_used_sec`) read 0. The console's usage page shows them; not read this time (owner).
- Egress: not measured (same reason).

**Usage model** (assumptions, since Q11, the product, is undefined):

- At 0.25 CU, 100 CU-hours = **400 awake hours a month**. A 31-day month has 744 h, so Free covers the compute being awake ≤ 54 % of the time. Always on, it would use 186 CU-hours and run out around **day 17**, after which production has no database until the 1st (or an upgrade).
- Every wake costs at least the 5-minute idle tail (≈ 0.02 CU-hours). The daily `db-backup.yml` jobs wake it about once a day (under 1 CU-hour a month). Requests spaced less than 5 minutes apart keep it awake: steady traffic for ~13 h a day (e.g. tenants in a couple of time zones), or any uptime check that reaches the database every few minutes, approaches the limit.
- Storage: the foundation tables cost a few KB per tenant (user, account, member, organization, billing). The ~480 MiB headroom will be decided by product tables, and by tables that grow with traffic rather than tenants (`session`, `rate_limit`, `verification`, `billing_webhook_event`; this repo has no job pruning them).
- Egress: Hyperdrive caching is off (ADR-0004), so every query result crosses Neon's network; 5 GB a month is ~170 MB a day.

**What failure looks like on Free.** Running out of CU-hours or egress is a **full outage** for every tenant (sign-in included) that lasts until the 1st unless the plan is upgraded (which lifts it). Hitting the storage cap breaks every write, including sign-in sessions and webhook deduplication. Neither deletes data. Today nothing would tell us first: alerting is deferred (ADR-0015) and Free has no spending notifications or consumption API.

**Unaffected by the plan:** the off-provider dumps (ADR-0023) stay, whatever the plan; they are the only copy that survives losing Neon.

## Options

1. **Stay on Free, watched, with an upgrade trigger.** $0. Accepts the limits above, cold starts after every idle period, and a 6-hour restore window (beyond it: snapshot branches and dumps). "Watching" without alerting means a manual console check (runbook "Database"). Risk: a missed check ends in an outage that only an upgrade or the 1st ends.
2. **Upgrade the `Business` organization to Launch.** Minutes, no data move. Production at its current shape costs its CU-hours × $0.106 (e.g. 100 CU-hours = $10.60; always on = $19.72 a 31-day month) plus storage (≈ $0.01 at 30 MiB) and restore history ($0.20/GB-month of changes). The preview project and the three unrelated projects become billable too, with no spend cap (notifications only).
3. **Move production to its own organization on Launch** (recommended when the trigger fires). Create an organization, put it on Launch, transfer `flat-cherry-23373668` into it. Same costs as option 2 for production only; preview and other projects stay on Free. Extra steps: disconnect project integrations (if any) before the transfer; the `saas-foundation` organization API key (`NEON_API_KEY` in the GitHub `production` environment, used by `db-backup.yml`) is a `Business` key, so expect to create a project-scoped key in the new organization and replace the secret, then dispatch `db-backup.yml` to prove it (whether the old key keeps working after the transfer is unverified). The production deploy and migrate commands use the owner's personal Neon login and only need access to the new organization.
4. **Scale.** Not now: about twice Launch's compute price; its extras (SLA, compliance, 30-day history, 25 branches) have no trigger yet.

Once on Launch (options 2–3), decide separately: restore window 1 day → 7 days (ADR-0003's original intent; billed by GB-month of changes), whether to disable scale-to-zero (no cold starts, ~$20/month at 0.25 CU), and whether Neon's scheduled snapshots replace the `backup-*` snapshot branches (ADR-0003 option A). Usage then becomes visible through spending notifications and the consumption API, which covers "watch usage" without ADR-0015's alerting.

## Decision (proposed)

- **Until the trigger: option 1**, with the limits in this ADR's Context accepted as they stand, and the manual check below.
- **Upgrade trigger: the first of**
  1. before **Polar production mode** (first paying customer; runbook "Polar"), or before **`SIGNUP_MODE=open`** (milestone D), whichever comes first: a paying or public tenant base shouldn't depend on a manual check to avoid a month-long outage, and Launch at this usage costs a few dollars;
  2. a check shows **CU-hours ≥ 50 before the 15th, or ≥ 70 at any point** of the period;
  3. `main` logical size **≥ 256 MiB** (half the cap);
  4. egress **≥ 2.5 GB** in a period;
  5. any suspension or storage-cap write failure (upgrade at once: it lifts the suspension).
- **Path: option 3** (production alone on Launch), unless the owner prefers option 2 to keep one organization.
- **Watch, until alerting exists** (runbook "Database"): the owner checks the Neon console (production project → usage: CU-hours, storage, egress for the current period) **every Monday and before each production deploy**, and upgrades when a trigger above is met. `neon branches list --project-id flat-cherry-23373668 -o json` (`logical_size` of `main`) is a read-only CLI alternative for storage.

## Consequences

- Milestone D's Neon condition is met by accepting this ADR: either the limits are accepted with the trigger and check above, or the plan is upgraded first.
- Until the upgrade, a full production outage from exhausted CU-hours or egress is possible and is caught only by the weekly check; acceptable only while production holds smoke-test or allowlisted, non-paying data.
- The upgrade itself changes no code, binding or connection string; option 3 rotates one GitHub secret.
- ADR-0003's amendment stays the record of the Free constraints until the upgrade; the upgrade is recorded as an amendment there (plan, date, restore window, scale-to-zero choice) with the runbook's "Database" section renamed from "Neon Free".
- Follow-up, not in this ADR: have `db-backup.yml`'s snapshot job read `main`'s `logical_size` and fail above the storage trigger, so a GitHub failure email flags it without ADR-0015's alerting.
