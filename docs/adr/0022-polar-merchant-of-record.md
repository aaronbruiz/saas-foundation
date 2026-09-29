# ADR-0022: Polar as billing provider and merchant of record; one Polar team customer per organization

Status: Proposed · Date: 2026-09-29

Supersedes in part [ADR-0018](0018-billing-platform.md) (the provider, its SDK, webhook endpoint, secret and signature scheme) and [ADR-0020](0020-billing-product-policy.md) (tax through Stripe Tax, prices by Stripe lookup key, the Stripe Customer Portal, going live with Stripe). Keeps [ADR-0009](0009-billing-plans-entitlements-stripe-adapter.md)'s model: plans → entitlements → authorization, the provider behind an adapter. This is the "Merchant of Record later" that ADR-0009 kept open.

## Context

- **Seller.** The owner sells from Peru. With Stripe, the seller is merchant of record and owns sales-tax/VAT registration and filing in every jurisdiction that needs it (ADR-0020 required activating Stripe Tax and its registrations before going live). With a merchant of record, the MoR sells to the customer, charges and remits the tax, and pays the seller out.
- **Nothing to migrate.** Stripe was never connected and production isn't deployed: no real customers or subscriptions exist anywhere.
- **Polar (documented, 2026-09).**
  - Merchant of record; payouts to individuals and businesses in the country of residence in local currency. Peru (PE) is on the payout-country list.
  - Customers can be `type: "team"` with members (`owner`, `billing_manager`, `member`), managed by id through the API. Promoting a member to `owner` demotes the previous owner to `billing_manager`, who keeps billing access until deleted.
  - API versions are chosen by the SDK import path (`@polar-sh/sdk/<version>`); `2026-04` is the current stable version, each version is supported for a limited window (about 9 months).
  - Webhooks follow Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
  - Exit: Polar documents moving customers and saved cards to Stripe.
- **Sandbox experiment** (branch `eval/polar-org-customer`, harness `apps/web/eval/`, run `r1-0929`, inside workerd, API `2026-04`, SDK 1.0.0):
  - the SDK has no dependencies and runs in workerd; webhook verification accepts a correctly signed body and rejects a tampered body, a wrong secret and a one-hour-old timestamp;
  - "find or create the organization's customer" (get by `external_id` → create → on failure read again) under 8 concurrent calls produced exactly one team customer; the same person owned separate customers for two organizations;
  - a team customer can buy a fixed-price (non-seat) monthly product, with and without a 14-day trial; each subscription carried its own `organization_id` metadata and product `price_key`; no organization-level member setting was needed;
  - ownership transfer (add new owner as member → promote to owner → delete former owner) worked; the new owner's customer session sees only that organization's subscription; a session for the deleted former owner is refused (422); the former owner's email login to the hosted portal still works but shows only the organizations they still belong to;
  - the invoice reads "_<seller>_ via Polar Software, Inc." with Polar's address, billed to the customer's name; the card statement shows `POLAR*<seller>`;
  - deleting a customer cancels its subscriptions **asynchronously** (still `trialing`/`active` right after, `canceled` about 2–3 minutes later);
  - the checkout left the billing country at a default (Angola) that nobody chose.
- **Not tested yet:** live webhook delivery and payloads, plan changes and proration in the portal, failed renewals (`past_due` → `unpaid`/`canceled`), refunds.

## Decision

- **Provider:** Polar, as merchant of record. `@polar-sh/sdk/2026-04` is imported only in `apps/web/src/modules/billing/providers/polar.ts` (lint-enforced, like `stripe` today). The Stripe adapter is removed when the Polar one lands; ADR-0009's `BillingProvider` seam is what keeps a later change possible.
- **Customer identity: one Polar team customer per organization.**
  - `external_id` = our organization id (unique and immutable in Polar), `metadata.organization_id` the same, name = the organization's name (it's what the invoice bills).
  - Created by our server with the find-or-create above before the first checkout, never by the checkout itself; every checkout passes `customer_id`.
  - Webhook link (ADR-0018 unchanged in spirit): the subscription's `metadata.organization_id`, set by our checkout; the adapter also requires the customer's `external_id` to match, otherwise the event is recorded and not applied (`billing.webhook.conflict`).
- **Members mirror `billing:manage`.** Today that's the organization owner only (ADR-0020), so the Polar customer has exactly one member: the owner, `external_id` = our user id.
  - On an ownership transfer our server adds the new owner, promotes them, then **deletes** the former owner. Demotion alone is not revocation (`billing_manager` keeps billing access).
  - The sync is an idempotent side effect keyed by (organization, owner user id). Checkout and portal calls also reconcile members before creating a session, so a failed sync is repaired on the next billing action.
  - Our app never relies on Polar for authorization: `authorize(ctx, 'billing:manage')` runs first, and the portal session is created with `external_member_id` = the caller.
- **Portal:** Polar's hosted customer portal through a customer session (plan changes, payment methods, invoices, cancellation), replacing the Stripe Customer Portal.
- **Prices:** Polar has no lookup keys. One Polar product per sellable price, carrying `metadata.price_key` (`pro_monthly`, `pro_yearly`); the adapter resolves `price_key` → product id. `policy.ts` keeps naming price keys only.
- **Tax:** Polar computes, collects and remits it. `automaticTax` leaves the provider interface; ADR-0020's decision 2 becomes "tax: provider is merchant of record". Checkout must collect the real billing country (the POC checks prefill and validation).
- **Webhooks:** `POST /api/billing/webhooks/polar`, verified on the raw body with the SDK's Standard Webhooks check (default tolerance) before any parsing, deduplicated by `webhook-id` in `billing_webhook_event` (provider `polar`), then mapped to the same `BillingEvent`. Ordering stays ADR-0018's per-subscription rule on the event timestamp. Size, error and logging rules are ADR-0018's.
- **Statuses:** Polar's `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid` map like Stripe's (`incomplete_expired` → `canceled`, unknown → `incomplete`). Entitled statuses stay ADR-0020's.
- **State comes only from webhooks.** Deleting a Polar customer is never the way to end a subscription (it cancels asynchronously); organization deletion stays refused while a subscription is live (ADR-0020).
- **Secrets and environments:** `POLAR_ACCESS_TOKEN` (organization token, least scopes: customers, members, products read, checkouts, customer sessions, subscriptions read), `POLAR_WEBHOOK_SECRET`, and `POLAR_SERVER` (`sandbox` | `production`, default `sandbox`). Without the token the billing actions answer 503; without the webhook secret the webhook does. Previews get none (ADR-0021).
- **No new Cloudflare binding, product or Worker.** Secrets only.

## Consequences

- Plans, entitlements, limits and the webhook's dedupe/ordering don't change. `policy.ts` changes only its tax note.
- The owner no longer registers for or files sales tax/VAT; Polar's fee (higher than card processing alone) is the price of that.
- Ownership transfer gains a billing side effect; its failure mode is a former owner keeping portal access until the next billing action repairs it. The app's own authorization is unaffected.
- The API version is one import path; before `2026-04`'s support ends, the upgrade is a PR that reruns the eval harness against the sandbox.
- Order of work:
  1. **Seam cleanup:** `BillingProvider` without `automaticTax`, customer creation behind the provider (`ensureCustomer`), lint rule for `@polar-sh/*`; Stripe behaviour unchanged.
  2. **POC** (`providers/polar.ts`, webhook route, member sync) against the sandbox, closing the untested items above (webhook payloads, portal plan change, failed renewal, billing country).
  3. Remove the Stripe adapter and its secrets; update AGENTS.md (invariant 6, module map, review rules) and the runbook in that PR.
