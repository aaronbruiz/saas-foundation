# ADR-0018: Billing platform: verified webhooks, organization-owned subscription state, default entitlements

Status: Accepted · Date: 2026-09-28

Implements the product-independent part of [ADR-0009](0009-billing-plans-entitlements-stripe-adapter.md). The plan catalog, prices, limits and access policy wait for the owner's product decisions (listed below).

## Context

The owner split Phase 3: build the billing platform now, which needs no product decisions, and leave plans and entitlements until the product is defined. ADR-0009 fixed the model (plans → entitlements → authorization, Stripe behind an adapter). AGENTS.md invariants 6 and 11 fix the rules (entitlements only; webhooks verified on the raw body and deduplicated).

## Decision

- **Provider:** Stripe, through the `stripe` SDK (Workers build).
  - It's imported only in `apps/web/src/modules/billing/providers/stripe.ts`. That file verifies the signature on the raw body (`constructEventAsync`, Web Crypto, Stripe's default 5-minute tolerance), then Zod-parses only the fields we store and maps them to a provider-neutral event.
  - No Stripe API key and no outbound Stripe calls yet: checkout and the customer portal come with the plan catalog.
- **Endpoint:** `POST /api/billing/webhooks/stripe` → `modules/billing/webhook.ts`.
  - Secret: the Worker secret `STRIPE_WEBHOOK_SECRET`. Unset means 503 for everything (fail closed); previews and local dev have none.
  - Bad signature → 400. Unexpected shape after verification → 400. Body over 512 KiB → 413 (bytes: `Content-Length` first, then counted while streaming). None of these write anything.
  - Database failure → 500, logged as `billing.webhook.failed`. Nothing is committed, so the provider's retry is processed normally.
  - Logs carry `event`, `rayId` and the event type only, never the payload (ADR-0015).
- **Dedupe and ordering** (`packages/db/src/billing.ts`, `applyBillingEvent`), in one transaction:
  1. insert `(provider, event_id)` into `billing_webhook_event`; a conflict means duplicate, acknowledged and not reapplied. Concurrent deliveries of one event serialize on that key;
  2. lock the organization row (`FOR NO KEY UPDATE`), so all events for one organization apply one at a time, including its first;
  3. ordering is **per subscription**:
     - for the stored subscription, an event at least as new (`created`) applies;
     - another subscription never applies a cancellation;
     - another subscription replaces a canceled one whenever it arrives, and a live one only if newer.
- **Every outcome except a database error is final** (acknowledged with 200), so no verified event makes the provider retry forever.
- **Known limit:** Stripe's `created` has one-second resolution, so two events for one subscription in the same second apply in arrival order. The fix is Stripe's recommended pattern of re-fetching the subscription when an event arrives. It needs the Stripe API key, so it comes with checkout.
- **Ownership:** the subscription belongs to the **organization**: one row per organization in `billing_subscription`.
  - The link is the subscription's metadata `organization_id`, which our own checkout will set. It's trusted only because the event is signed.
  - An event with no link, or naming an organization that doesn't exist, is recorded and acknowledged, not applied (`billing.webhook.unlinked`).
  - A subscription stays with the organization it was first linked to. An event linking it to another organization is recorded and acknowledged, not applied (`billing.webhook.conflict`).
  - Deleting an organization that has billing state is refused with **409** (Better Auth `beforeDeleteOrganization` hook) until the owner decides what should happen. The foreign key (`ON DELETE RESTRICT`) is the backstop.
- **Stored state:**
  - provider ids (customer, subscription, first item's price);
  - internal status: Stripe's `incomplete_expired` → `canceled`, and **unknown future statuses → `incomplete`** (non-entitled);
  - latest item period end, `cancel_at_period_end`, and the event time;
  - `plan_key`, which stays **null** until the catalog maps prices to plans.
- **Entitlements:** `getEntitlements(orgId)` in `modules/billing/entitlements.ts`. `orgId` must come from `getTenantContext`.
  - `PLAN_CATALOG` is empty, so every organization gets `DEFAULT_ENTITLEMENTS` (`planKey: null`, no features).
  - A plan's entitlements apply only when the status is `active` or `trialing` **and** its `plan_key` is in the catalog. Anything else falls back to the default.
- **No new Cloudflare binding, product or Worker.** One new secret.

## Product decisions still needed (owner)

1. Plan catalog: which plans; free tier and/or trial (length, card required); monthly/annual; currency; the price → plan mapping.
2. What is billable: flat per organization, per seat, per usage metric; tax handling (Stripe Tax or a Merchant of Record).
3. Limits per plan; hard block or overage at the cap; what a downgrade does when over the cap.
4. Who may manage billing (owner only, or admin too). The capability goes into the permission matrix.
5. The features each plan unlocks (needs the real product resources; `projects` is only a reference domain).
6. Lifecycle: grace period for `past_due`/`unpaid` (today they lose plan entitlements immediately); what cancelling does (read-only? data retention); refunds.
7. Deleting an organization with billing state (today refused by the database).
8. Whether an organization can ever hold more than one subscription (today one), and whether a subscription may move between organizations (today refused).

## Consequences

- Stripe can be connected (an endpoint plus `STRIPE_WEBHOOK_SECRET`) without changing any access: entitlements stay at the default until the catalog exists.
- `billing_webhook_event` grows by one row per delivery. Pruning is deferred until volume makes it matter.
- Switching provider means a new file under `providers/` that produces the same `BillingEvent`. The stored model doesn't change.
