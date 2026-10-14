# ADR-0032: Lift the data gate: an allowlisted pilot with real customer data on Polar's sandbox

Status: Accepted (owner 2026-10-14: lift the gate; free pilot on Polar's sandbox). Takes effect when the "Rollout" steps are recorded; until then production holds only smoke-test accounts. · Date: 2026-10-14

Supersedes in part [ADR-0014](0014-first-production-launch-gates.md) decision 1 (the data gate). This is milestone C (runbook "First production deploy"): real customer data, sign-up still allowlisted. Public sign-up (milestone D) and Polar production mode stay separate, later decisions.

## Context

ADR-0014 keeps real customer data out of production until off-provider backups exist and a restore from them has been tested; lifting the gate is an owner decision recorded in a new ADR. The runbook's milestone C adds the other conditions. State on 2026-10-14:

| Condition (runbook milestone C)                  | State                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup option B implemented and a restore tested | Met: daily `pg_dump` to R2 since 2026-09-30, restore test passed 2026-09-30 ([ADR-0023](0023-off-provider-database-dumps-to-r2.md)); `db-backup.yml` succeeded daily, last 2026-10-14 |
| Alerting operational                             | Met: [ADR-0031](0031-production-alerting-issues-to-slack.md), tested end to end 2026-10-14                                                                                            |
| Email delivery live, email verification enforced | Met: [ADR-0024](0024-email-activation-send-email-binding.md) (2026-10-01), verification enforced 2026-10-01 ([ADR-0016](0016-transactional-email.md), runbook "Email" step 5)         |
| Smoke-test accounts removed                      | **Not yet**: their organizations hold Polar sandbox subscriptions still under the runbook's pre-go-live date checks (≈ 2026-10-21 and after 2026-10-30 06:08Z)                        |
| A new ADR lifting the data gate                  | This ADR                                                                                                                                                                              |

Also relevant:

- **Billing runs on Polar's sandbox** (runbook "Polar"). Switching to `POLAR_SERVER=production` needs milestone C first, the pre-go-live checks passed, and ADR-0026's Neon upgrade (its trigger 1).
- **Neon Free** ([ADR-0026](0026-neon-plan-capacity-and-upgrade-trigger.md)) is accepted while production holds smoke-test or allowlisted, non-paying data; a pilot on the sandbox is that.
- **Legal pages** (`/privacy`, `/terms`, `/subprocessors`, `apps/web/src/lib/legal.ts`) exist, but all three are drafts (`effectiveDate: null`). The subprocessor registry lists Cloudflare, Neon and Polar, not Slack (ADR-0031's alert destination, which can receive unredacted error messages).

## Decision

1. **The data gate is lifted** (owner, 2026-10-14), effective when the Rollout below is recorded. Until then, production keeps only smoke-test accounts, as ADR-0014 says.
2. **Sign-up stays allowlisted.** `SIGNUP_MODE` stays unset; `SIGNUP_ALLOWLIST` holds only the admitted customers' addresses, no smoke-test address. Public sign-up is milestone D, with its own ADR.
3. **Billing: a free pilot on Polar's sandbox** (owner's choice over switching Polar to production first or hiding checkout). Accepted consequences:
   - a pilot organization can "buy" Pro in Polar's sandbox checkout with a test card: Pro features without payment;
   - Polar's sandbox receives real data for pilot customers (organization id and name, billing managers' user ids and emails, the checkout IP, what they type at checkout), as the subprocessor registry already describes for Polar;
   - no revenue, and no tax or invoicing through Polar, until production mode.
4. **Polar production mode gets a new precondition:** a plan, recorded before switching, for pilot organizations' sandbox subscriptions and customer links. The runbook's "delete those organizations while still in sandbox mode" applies to smoke-test organizations only; pilot organizations hold real data and aren't deleted. ADR-0026's Neon upgrade still comes first.
5. **Controls that now carry real data, unchanged:** R2 dumps and Neon snapshots (ADR-0023, ADR-0003) hold customer data under their retention; logs stay free of PII (ADR-0015); alerting (ADR-0031); the weekly Neon check (ADR-0026). Smoke-test rows remain in older dumps, snapshots and Neon's restore history until those age out; they're synthetic.

## Rollout

In order. Each step is recorded here (date, counts or ids, no personal data) before the next.

1. **Polar date checks done:** the runbook's "Failed renewal" and "Cancellation at period end" checks are ticked (≈ 2026-10-21; after 2026-10-30 06:08Z).
2. **Smoke-test organizations deleted, in sandbox mode:** every subscription `canceled` and its Billing page on Free, then each organization deleted by its owner through Better Auth's organization delete endpoint (`/api/auth/organization/delete`), so the deletion hooks run (billing-state check, then removal of the Polar billing account, refusing the deletion if that fails; ADR-0022). Never by SQL. Afterwards, in the Neon SQL editor: no organization, member, invitation or billing row left for them.
3. **Smoke-test users deleted:** no user-deletion endpoint is enabled, so by SQL, once they have no memberships left. The exact statements and their checks go into the runbook in their own PR and are reviewed before running. Afterwards: zero users, sessions and accounts for the smoke-test addresses.
4. **Legal and registry:** the owner makes `/privacy` and `/terms` effective (text and `effectiveDate` in `lib/legal.ts`), and Slack is added to the subprocessor registry (or the owner records why it isn't one). Both before the first customer is admitted.
5. **Allowlist replaced:** `pnpm --filter web exec wrangler secret put SIGNUP_ALLOWLIST` with only the admitted customers' addresses; `SIGNUP_MODE` stays unset. The secret change creates a version without a release tag, so the next release holds (runbook "Releases").
6. **Recorded:** the date the gate is lifted and how many addresses were admitted (no addresses), here and in the runbook's milestone C.

## Consequences

- Milestone C is met when the Rollout is recorded. Milestone D (public sign-up) and Polar production mode remain open, each with its own decision.
- Pilot customers can use Pro without paying until Polar production mode. Moving them to production billing needs the plan from decision 4.
- ADR-0014 gets a "Superseded in part by ADR-0032" line for decision 1.
