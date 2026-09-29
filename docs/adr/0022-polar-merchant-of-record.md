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
- **Second run** (`r2-0929`, same harness):
  - webhook payloads, read from Polar's delivery log: every `subscription.*` event (`created`, `active`, `updated`, `canceled`, `revoked`) embeds `customer` with `external_id`, plus `metadata.organization_id` and `product.metadata.price_key`; the event `timestamp` has microsecond resolution; `member.*` events carry the member's `external_id` and `customer_id`;
  - a customer session lives 60 minutes; after the member is deleted, or the whole customer, an already-issued session is refused (401) on the next call;
  - a portal email login open in a browser is logged out on the next reload once its member is deleted, and a new login sends no code;
  - Polar refuses to delete a team customer's only owner (422, "Cannot delete the only owner. Transfer ownership first.").
- **Not tested yet:** plan changes and proration in the portal, failed renewals (`past_due` → `unpaid`/`canceled`), refunds, the billing-country prefill.

## Decision

- **Provider:** Polar, as merchant of record. `@polar-sh/sdk/2026-04` is imported only in `apps/web/src/modules/billing/providers/polar.ts` (lint-enforced, like `stripe` today). The Stripe adapter is removed when the Polar one lands; ADR-0009's `BillingProvider` seam is what keeps a later change possible.
- **Customer identity: one Polar team customer per organization.**
  - `external_id` = our organization id (unique and immutable in Polar), `metadata.organization_id` the same, name = the organization's name (it's what the invoice bills).
  - Created by our server with the find-or-create above before the first checkout, never by the checkout itself; every checkout passes `customer_id`.
  - Webhook link (ADR-0018 unchanged in spirit): the subscription's `metadata.organization_id`, set by our checkout, and the customer's `external_id` must agree.
    - The adapter reads the customer's `external_id` from the verified payload (every `subscription.*` event carries it, run `r2-0929`); a payload without it is treated as a missing link below, never looked up.
    - A mismatch or a missing `external_id` maps to `organizationId: null`, so the event is recorded and acknowledged as `unlinked`, never applied. `SubscriptionSnapshot` and `applyBillingEvent` don't change.
- **Members mirror `billing:manage`.** Today that's the organization's owners (ADR-0020). Each is a member of the organization's Polar customer with `external_id` = our user id; one of them is the Polar `owner`, the others `billing_manager`. Only organizations that already have a Polar customer are synced.
  - **Revoke before, grant after**, in Better Auth's organization hooks, so every path (including Better Auth's directly reachable HTTP endpoints) goes through them:
    - revoke: `beforeUpdateMemberRole` (an owner becomes anything else), `beforeRemoveMember` (an owner is removed) and the `/organization/leave` path (in the `hooks.before` middleware, like `/organization/delete` today) **delete** that person's Polar member first. If Polar can't be updated, the hook throws and the change is refused. Demotion to `billing_manager` is not revocation.
    - grant: `afterUpdateMemberRole` (becomes owner), `afterAddMember` and `afterAcceptInvitation` (joins as owner) add the person to Polar, promoting them to Polar `owner` when the Polar owner is being replaced.
    - A revocation that succeeds in Polar while the app's write then fails leaves an owner without Polar access; a failed grant leaves a new owner without it. Both fail toward less access, and checkout and portal calls reconcile the caller's membership before creating a session.
    - Polar refuses to delete a customer's only owner (422), so a transfer always grants the new owner first; demoting or removing the organization's last owner while it has a Polar customer is refused by the revoke hook.
    - **Deleting the organization** (allowed only once no subscription is live, ADR-0020) deletes its Polar customer first, which removes every member's access. It runs only in `beforeDeleteOrganization`, which Better Auth calls inside its endpoint after its own permission check (the POC verifies that ordering), never in the `/organization/delete` middleware, which runs before that check and stays a live-subscription 409 only. If Polar can't be updated, the hook throws and the deletion is refused (fail closed). Because nothing is live, the asynchronous cancellation seen in the eval can't end a paid subscription here. Tests: direct HTTP deletion attempts by an admin and a member leave the Polar customer intact.
  - Our app never relies on Polar for authorization: `authorize(ctx, 'billing:manage')` runs first, and the portal session is created with `external_member_id` = the caller. Sessions are created on demand and never stored.
  - **Revocation window: immediate** on both paths (run `r2-0929`). A customer session issued before its member or customer was deleted is refused on the next call; an open portal email login is logged out on the next reload. Customer sessions also expire after 60 minutes regardless.
- **Portal:** Polar's hosted customer portal through a customer session (plan changes, payment methods, invoices, cancellation), replacing the Stripe Customer Portal.
- **Prices:** Polar has no lookup keys. One Polar product per sellable price, carrying `metadata.price_key` (`pro_monthly`, `pro_yearly`); the adapter resolves `price_key` → product id. `policy.ts` keeps naming price keys only.
- **Tax:** Polar computes, collects and remits it. `automaticTax` leaves the provider interface; ADR-0020's decision 2 becomes "tax: provider is merchant of record". Checkout must collect the real billing country (the POC checks prefill and validation).
- **Webhooks:** `POST /api/billing/webhooks/polar`, verified on the raw body with the SDK's Standard Webhooks check (default tolerance) before any parsing, deduplicated by `webhook-id` in `billing_webhook_event` (provider `polar`), then mapped to the same `BillingEvent`. Ordering stays ADR-0018's per-subscription rule on the event timestamp. Size, error and logging rules are ADR-0018's.
- **Statuses:** Polar's `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid` map like Stripe's (`incomplete_expired` → `canceled`, unknown → `incomplete`). Entitled statuses stay ADR-0020's.
- **State comes only from webhooks.** Deleting a Polar customer is never the way to end a subscription (it cancels asynchronously); organization deletion stays refused while a subscription is live (ADR-0020).
- **Secrets and environments:** `POLAR_ACCESS_TOKEN` (organization token, least scopes: customers, members, products read, checkouts, customer sessions, subscriptions read), `POLAR_WEBHOOK_SECRET`, and `POLAR_SERVER` (`sandbox` | `production`, default `sandbox`). Without the token the billing actions answer 503; without the webhook secret the webhook does. Previews get none (ADR-0021).
- **No new Cloudflare binding, product or Worker.** Secrets only.

## Consequences

- Plans, entitlements, limits and the webhook's dedupe/ordering don't change. `policy.ts` only loses `CHECKOUT.automaticTax` (tax belongs to the adapter).
- The owner no longer registers for or files sales tax/VAT; Polar's fee (higher than card processing alone) is the price of that.
- Owner changes gain a Polar call in their path: while Polar is unreachable, demoting or removing an owner of an organization with a Polar customer is refused (fail closed). The app's own authorization is unaffected.
- The API version is one import path; before `2026-04`'s support ends, the upgrade is a PR that reruns the eval harness against the sandbox.
- Order of work:
  1. **Seam cleanup** (#38): provider-neutral errors and a `WebhookParser` (raw body + headers); checkout and portal requests carry the organization name and the caller's user id; `automaticTax` leaves the interface and `policy.ts` (the Stripe adapter keeps Stripe Tax on); lint rule for any provider SDK including `@polar-sh/*`. Stripe behaviour unchanged.
  2. **POC** (`providers/polar.ts` with the customer find-or-create, webhook route, member sync hooks) against the sandbox, closing the untested items above (portal plan change, failed renewal, billing country). Tests: owner transfer, demotion, removal, leave and organization deletion through Better Auth's HTTP endpoints, each with Polar failing, plus cross-tenant webhook linking.
  3. Remove the Stripe adapter and its secrets; update AGENTS.md (invariant 6, module map, review rules) and the runbook in that PR.
