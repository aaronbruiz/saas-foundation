# ADR-0037: Backup heartbeat on Healthchecks.io

Status: Proposed (owner choices 2026-10-15: Healthchecks.io, alerts by email and Slack) · Date: 2026-10-15

## Context

[ADR-0036](0036-recovery-objectives.md) sets a backup copy-age target of 24 h with an alert at 32 h, and leaves detection to this ADR. Today nothing alerts on a stale backup:

- `db-backup.yml` has no notification step, and [ADR-0031](0031-production-alerting-issues-to-slack.md)'s Slack alerts cover the app Worker only.
- GitHub's failed-workflow emails are sent when a run **completes**. A stuck run sends nothing until it ends: on 2026-10-02 the `dump` job waited at the `production` environment gate for 65.6 h, and the next two scheduled runs were cancelled behind it, with no alert.
- [ADR-0023](0023-off-provider-database-dumps-to-r2.md) assumed a failed run "surfaces as GitHub's failed-workflow email"; that doesn't cover stuck, dropped or cancelled runs.

GitHub Actions has no payment method (owner 2026-10-15), so detection mustn't cost Actions minutes.

## Decision

1. **A dead-man's switch on [Healthchecks.io](https://healthchecks.io)** (Hobbyist plan, free): one check, `saas-foundation-db-backup`, simple schedule, **period 1 day, grace 8 h**. With no successful ping for 32 h (ADR-0036's alert threshold) the check goes down and alerts.
2. **The `dump` job reports every outcome it reaches**, in a last step that runs unless the run was cancelled:
   - `/fail` when the `snapshot` job or the dump failed, which alerts at once;
   - `success` (the plain ping URL) only when both succeeded **and the dump uploaded a new copy** (`dump.sh` reports `uploaded=true`);
   - nothing when a same-day re-run made no new copy (`dump.sh` skips a complete day), so the check keeps counting from the real copy and the 32 h threshold stays tied to copy age.
   - The step is inline shell (`curl -fsS -m 10 --retry 5`), so it still runs when checkout or setup failed. If the secret is missing it fails the job instead of skipping.
   - A run that never reaches the step (stuck at the gate, dropped by the scheduler, cancelled) sends nothing, and the grace expiry alerts.
3. **Alerts go to the owner's email and to the private Slack alerts channel** (ADR-0031), through Healthchecks.io's own email and Slack integrations.
4. **The ping URL is a secret**, `HEALTHCHECKS_PING_URL` in the `production` environment, next to the backup credentials (`main` only, ADR-0019). Anyone holding it can only send pings: fake "fresh" or fake "failed". It grants no access to data, code or infrastructure.

## Security review

- **What Healthchecks.io receives.** Per ping: the time, the kind (success or fail), the scheme, method and user agent, and the remote address, which is a GitHub-hosted runner's IP (from its open-source `Ping` model). We send no body. **No customer data, no credential, nothing about the database.** It isn't a subprocessor (it handles no customer personal data), so the registry in `apps/app/src/lib/legal.ts` doesn't change.
- **Who runs it.** SIA Monkey See Monkey Do, Riga, Latvia (EU). Hosting on Hetzner; encrypted database backups on AWS, kept up to 2 months; subprocessors listed in its privacy policy (checked 2026-10-15). The software is open source (BSD-3-Clause), so it can be self-hosted if the service goes away.
- **Slack.** Healthchecks.io's Slack integration holds a post-only incoming webhook for the alerts channel. A leak lets someone post into that private channel; alerts carry only the check's name and status. ADR-0031 keeps its own webhook in Cloudflare; this is a second, separate one.
- **Failure modes.** Healthchecks.io down or unreachable: a ping fails (the step fails and GitHub's failed-workflow email follows), or an alert is late. A leaked ping URL could suppress the alert by faking success. A check's UUID can't be changed, so the response is a replacement check with the same settings and integrations, the new URL in `HEALTHCHECKS_PING_URL`, a confirmed first ping, then deleting the old check (runbook).
- **Free-plan limits.** 20 checks, 100 log entries per check (about three months at one ping a day); SMS and phone aren't used.

## Alternatives

| Option                                                                             | Why not                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A scheduled Cloudflare Worker that asks the GitHub API for the last successful run | A new Worker (invariant 14), a GitHub token with Actions read access stored in it and rotated, code and tests to maintain, and alerts only through Workers Issues (no email without an email binding). Kept as the fallback if a vendor becomes unacceptable |
| A scheduled GitHub-only freshness workflow                                         | About 120 Actions minutes a month at 6-hourly checks, and the same scheduler as the backups, so it isn't independent                                                                                                                                         |
| Better Stack or Cronitor heartbeats                                                | Comparable free tiers (10 and 5 monitors, email and Slack); not open source, so no self-hosting fallback                                                                                                                                                     |
| Post to Slack from CI                                                              | A webhook in CI (ADR-0031 keeps it out), and it only reports runs that complete                                                                                                                                                                              |

## Consequences

- A stuck, dropped or cancelled backup now alerts within 32 h of the last good copy, without Actions minutes. ADR-0023's failed-run assumption is no longer the only signal.
- The check can't alert until its first ping, which comes from the first run after this change that uploads a new copy. Rollout isn't done until the owner has seen it "up" and tested a `/fail` delivery to email and Slack (runbook).
- Owner setup and the response to an alert: runbook "Database" (backup heartbeat) and "CI credentials".
- If the backup cadence changes (ADR-0036 decision 8), the check's period and grace change with it.
