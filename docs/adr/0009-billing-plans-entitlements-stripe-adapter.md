# ADR-0009: Billing: plans → entitlements, Stripe behind an adapter

Status: Accepted · Date: 2026-09-27

## Decision

- The product model is ours and provider-neutral: **plans → entitlements → authorization**.
- A provider (Stripe first) only **updates billing state** (`planKey`, internal `status`, `currentPeriodEnd`, `provider*` ids) via verified, idempotent webhooks.
- Authorization and feature code call `getEntitlements(orgId)` only. (2026-10-09: the entry point is now `entitlementsIn(db, ctx.orgId)` in `modules/billing/entitlements.ts`; `getEntitlements`, which took a bare orgId, was removed.)
- Only `apps/web/src/modules/billing/providers/**` may import `stripe` (lint-enforced).
- Moving to a Merchant of Record later must not change the product model.

## Consequences

- The provider is replaceable; pricing changes stay in the plan catalog.
- Open product questions (not technical): the plan catalog, access policy per billing status (`past_due`, `canceled`), trials. Implemented in Phase 3.
