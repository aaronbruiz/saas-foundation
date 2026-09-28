# ADR-0020: Billing product policy in one place, with reference defaults

Status: Accepted · Date: 2026-09-28

Supersedes in part [ADR-0018](0018-billing-platform.md): its eight open product decisions are resolved here. Also superseded: the entitled statuses (now `past_due` too), the refusal of every billed-organization deletion (now only while a subscription is live), `ON DELETE RESTRICT` (now `CASCADE` behind that guard), and `plan_key` always null (now resolved from the price).

## Context

This repository is a foundation that different products will be built on. The owner asked for the eight open billing decisions to be resolved with sensible defaults for the reference implementation, following one principle: **centralized product policy, not product assumptions embedded throughout the application**, and no speculative configuration engine.

What the investigation found:

- **Architecture.**
  - One Worker; domain modules under `apps/web/src/modules/`; all role rules in the capability matrix (`server/permissions.ts`); tenant data only through `packages/db` repositories.
  - `projects` is the only reference resource. Members and invitations belong to Better Auth, whose own HTTP endpoints (`/api/auth/organization/*`) are reachable directly, so a member limit enforced only in our service would be bypassable.
  - Better Auth takes `membershipLimit` (checked when an invitation is accepted and when a member is added) and `invitationLimit` (pending invitations), both as async functions.
- **Stripe's recommended subscription pattern** (Stripe docs "Build a subscriptions integration", "SaaS subscriptions"):
  - prices addressed by **lookup key**, so code never embeds price ids;
  - Checkout in subscription mode (`subscription_data.metadata`, `trial_period_days`, `automatic_tax`);
  - the hosted **Customer Portal** for plan changes, payment methods, invoices and cancellation;
  - state taken from `customer.subscription.*` webhooks.
  - Failed renewals go `past_due` while Smart Retries run, then `unpaid` or `canceled` by the dashboard's retry settings.
  - Cancel-at-period-end keeps the status `active` until the period ends.
- **Policy vs platform invariants.** Provider-neutral model, verified and deduplicated webhooks, organization-owned state, entitlement-based authorization, one canonical plan definition: these are **platform invariants** and don't change per product. Plans, prices, limits, features, trial, tax, the grace period and which statuses keep access are **product policy**. Who may manage billing is a **role rule** and lives with the other role rules. The deletion and single-subscription rules are billing lifecycle policy with a strong safe default.

## Decision

**Where the policy lives.** `apps/web/src/modules/billing/policy.ts` is the one place: a typed `PLANS` object and a few pure functions. It has no I/O, no provider, no database. A different product changes that file plus its own product resources.

Enforcement points only ask the policy:

| Rule                       | Enforced at                                                                                         | Asks                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| project limit              | `projects/service.ts` → `createWithinLimit` (org row lock, so concurrent creations can't overshoot) | `entitlementsFor(sub).limits.projects`        |
| member limit               | Better Auth `membershipLimit` + `invitationLimit` (every path, HTTP included)                       | `…limits.members` (wired in `server/auth.ts`) |
| plan from price            | webhook, before storing                                                                             | `planForPrice(lookupKey)`                     |
| checkout allowed, trial    | `billing/service.ts`                                                                                | `isLive`, `trialDaysFor`, `CHECKOUT`          |
| deleting an organization   | Better Auth middleware + hook                                                                       | `isLive`                                      |
| who sees / manages billing | capability matrix                                                                                   | `billing:read`, `billing:manage`              |

No rules engine and no database-driven catalog: a single product needs one typed constant, and types make a wrong key a compile error. A per-tenant or runtime-editable catalog needs its own ADR once a product actually needs it.

**The eight decisions (reference defaults):**

1. **Plans.**
   - **Free** (the default for every organization without an entitled subscription): 3 projects, 3 members.
   - **Pro**: unlimited projects, 50 members; monthly (`pro_monthly`) and yearly (`pro_yearly`) prices.
   - Amounts and currency live on the Stripe prices (USD for the reference setup), not in code.
   - **14-day trial**, only for an organization's first subscription; Checkout collects a payment method.
   - A retired price stays listed under its plan with `retired: true`: existing subscribers keep the plan, and Checkout no longer offers it.
2. **What is billable:** a flat price per organization (quantity 1). No per-seat billing: seats are a limit, not a meter. No usage metering. **Tax:** Stripe Tax through Checkout (`automatic_tax`), which requires activating Stripe Tax and its registrations before going live. No Merchant of Record: ADR-0009's adapter keeps that option open.
3. **Limits:**
   - hard stop on creating the resource at the cap: 403 with an upgrade message;
   - member invitations are refused when no seat is free, and acceptance is refused at the cap (for example after a downgrade);
   - the project cap is exact (creation takes the organization row lock). The seat cap is exact per request, but Better Auth counts and then inserts without a lock, so simultaneous acceptances can exceed it by their number. That's accepted because seats are a limit, not a meter, under flat pricing. A product that bills per seat needs a database-enforced cap (a trigger on `member` inserts) first;
   - **a downgrade never deletes or hides data**: existing projects and members stay, and new ones are blocked until usage is under the limit.
4. **Ownership and permissions:** the subscription belongs to the **organization** (unchanged).
   - `billing:read` (plan, usage) is granted to owner and admin.
   - `billing:manage` (checkout, portal) is **owner only**, matching Better Auth's rule that only the owner deletes the organization.
5. **Features:** the reference product's plans differ only by limits. `Entitlements.features` stays in the model (empty) as the place a product puts feature flags; authorization then checks `entitlements.features`, never a plan name.
6. **Lifecycle:**
   - `active`, `trialing` **and `past_due`** keep the paid plan. The grace period is Stripe's retry schedule: cutting access on the first failed charge punishes expired cards.
   - `unpaid`, `paused`, `incomplete` and `canceled` fall back to Free.
   - Cancellation happens in the portal, at period end. Data is kept, and the Free limits apply.
   - Plan changes and proration happen in the portal with Stripe's defaults.
   - Refunds are manual in the Stripe dashboard: no refund code.
   - A price the product doesn't sell is stored and grants Free (`billing.webhook.unknown_price`).
7. **Deleting an organization** is refused (409, "cancel it in Billing first") while its subscription is **live** (any status except `canceled`). The provider subscription still exists then: it charges or retries (`active`, `trialing`, `past_due`, `incomplete`), keeps creating invoices (`unpaid`), or can resume (`paused`), and it would outlive the organization.
   - The same set blocks a second checkout (decision 8).
   - That `canceled` is terminal is also a platform invariant: the webhook's per-subscription ordering relies on it (ADR-0018), so it isn't a product setting. Once the subscription has ended, deletion works and removes the billing record (`ON DELETE CASCADE`, migration 0004). The refusal runs before Better Auth's endpoint and only for members (ADR-0018).
8. **One subscription per organization.** Checkout is refused while one is live; changes go through the portal. A subscription never moves between organizations (unchanged: `conflict`).

**Implemented now:**

- the policy module;
- limit enforcement (projects, members);
- the webhook's price → plan mapping;
- Checkout and Customer Portal sessions behind a small `BillingProvider` interface (`providers/stripe.ts` implements it; tests pass a fake);
- a Billing page (plan, usage, upgrade and manage buttons for the owner).

Without `STRIPE_SECRET_KEY` (local dev, previews) the billing actions answer 503, and without `STRIPE_WEBHOOK_SECRET` the webhook does.

## Consequences

- Changing the product means editing `policy.ts`, plus the enforcement point of any new limit in its own resource's service. Tests in `test/billing.test.ts` pin the boundaries:
  - the default plan;
  - entitled statuses;
  - each price mapping to exactly one plan;
  - limits under concurrency;
  - seat limits through Better Auth;
  - owner-only purchase;
  - cross-tenant 404;
  - the trial only once;
  - customer reuse.
- `server/auth.ts` imports the pure billing policy, so Better Auth's endpoints enforce the same rules.
- Tests that aren't about limits put their organizations on a paid plan with a fixture (`onPaidPlan`). In the app, only verified webhooks write billing state.
- Going live with Stripe needs the setup in the runbook ("Stripe"): products and prices with the lookup keys, portal settings, Stripe Tax, the webhook endpoint, and two Worker secrets.
