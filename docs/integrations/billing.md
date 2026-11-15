# Billing: Polar

## Responsibility

Polar is the billing provider and merchant of record: hosted checkout, the customer portal (plan changes, payment methods, invoices, cancellation), tax, and payment collection ([ADR-0022](../adr/0022-polar-merchant-of-record.md)). Each organization is one Polar team customer, whose external id is the organization's id.

What stays ours: **which plans exist and what they allow** ([`billing/policy.ts`](../../apps/app/src/modules/billing/policy.ts), [ADR-0020](../adr/0020-billing-product-policy.md)), **who may manage billing** (`billing:manage`, the capability matrix), and **what access an organization has** (entitlements, computed from our stored copy of the subscription). Authorization reads entitlements only, never Polar or a subscription status (invariant 6).

## Owning files

| File                                                                                          | Role                                                                                                                              |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`modules/billing/policy.ts`](../../apps/app/src/modules/billing/policy.ts)                   | plans, price keys, limits, trial, which statuses keep a plan (`ENTITLED`), what counts as live (`isLive`)                         |
| [`modules/billing/provider.ts`](../../apps/app/src/modules/billing/provider.ts)               | the seam: `BillingProvider`, `BillingMembers`, `WebhookParser` and the errors that mean "never created", "unknown", "unavailable" |
| [`modules/billing/providers/polar.ts`](../../apps/app/src/modules/billing/providers/polar.ts) | the only file that knows Polar (`@polar-sh/*` and provider ids appear nowhere else; lint enforces it)                             |
| [`modules/billing/config.ts`](../../apps/app/src/modules/billing/config.ts)                   | which provider is configured, from Worker configuration                                                                           |
| [`modules/billing/service.ts`](../../apps/app/src/modules/billing/service.ts)                 | billing overview, start checkout, open portal                                                                                     |
| [`modules/billing/webhook.ts`](../../apps/app/src/modules/billing/webhook.ts)                 | `POST /api/billing/webhooks/polar`                                                                                                |
| [`modules/billing/entitlements.ts`](../../apps/app/src/modules/billing/entitlements.ts)       | `entitlementsIn(db, orgId)`: the public entry point other modules use                                                             |
| [`packages/db/src/billing.ts`](../../packages/db/src/billing.ts)                              | `applyBillingEvent`, the checkout gate (ADR-0043), the billing access gate (`gatedMemberWrite`, ADR-0044)                         |
| [`packages/auth/src/auth.ts`](../../packages/auth/src/auth.ts) organization hooks             | revoke billing access before an owner change, grant after, remove the customer before an organization is deleted                  |

## Configuration

| Name                   | Meaning                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`     | `polar` turns Polar mode on. Anything else: billing actions answer 503 and the webhook accepts nothing. Never inferred from a token.                                              |
| `POLAR_ACCESS_TOKEN`   | the organization token. In Polar mode without it: billing actions and webhooks answer 503, and owner removals, demotions and organization deletion are **refused** (fail closed). |
| `POLAR_WEBHOOK_SECRET` | verifies deliveries. Without it the webhook answers 503 to everything.                                                                                                            |
| `POLAR_SERVER`         | `production` or the sandbox (default).                                                                                                                                            |

Token scopes, products and their `price_key` metadata, and the webhook endpoint are set in Polar's dashboard (runbook "Polar" steps 2–6). Amounts and currency live only in Polar; `apps/site/src/data/prices.json` holds display amounts for the marketing site.

## Environments

| Environment   | Billing                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local         | off: the billing page shows the plan and usage, and Upgrade answers 503 "Billing is not configured". Tests use a fake provider and signed fake deliveries ([`test/polar-webhook.ts`](../../apps/app/test/polar-webhook.ts)). |
| Preview       | off: previews never get a Polar secret (ADR-0021)                                                                                                                                                                            |
| Production    | Polar mode against Polar's **sandbox** since 2026-09-30 (runbook "Polar"); switching to Polar production waits for its go-live checks                                                                                        |
| Sandbox evals | `apps/app/eval/polar-provider.test.ts`, run by the owner only, not in `pnpm test` or CI ([`docs/testing.md`](../testing.md#layers))                                                                                          |

## Data exchanged

To Polar: the organization's id and name, the customer's email (the owner starting the checkout), the buyer's IP (`cf-connecting-ip`, for the billing country), the price key and trial length, and the return URLs. From Polar: subscription state (status, price, period end, cancellation), re-read through the API for every subscription event. Checkout and portal links carry a session credential: they're never logged, stored or put in a chat or test output (Code Review Rules).

## Four states that are not the same thing

| State                   | Where it lives                       | What it proves                                                                      |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| The API answered        | the app's `startCheckout` call       | Polar created a checkout session and returned its URL. Nothing is paid yet.         |
| The provider completed  | Polar                                | The customer paid or started a trial. The app doesn't know until a webhook arrives. |
| The webhook was applied | `billing_subscription`               | A verified, deduplicated, re-read event changed our copy (outcome `applied`).       |
| The entitlement changed | computed on each read by `policy.ts` | The organization's limits and features are now the plan's.                          |

The return to `/t/<slug>/billing?checkout=success` proves none of these: the `checkout` marker isn't read and grants nothing. A timeout proves nothing either: a request that didn't answer may still have created a session.

## Failures

| Situation                                                    | Effect                                                                                                                | Log event                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Billing not configured                                       | 503 "Billing is not configured"                                                                                       | none                                                 |
| Already a live subscription                                  | 409 "Use Manage billing"; changes go through the portal (one subscription per organization)                           | none                                                 |
| Organization being deleted                                   | 409; Polar is never called                                                                                            | none                                                 |
| Billing access closed for the caller (account being deleted) | 409 "Billing is closed for your account"                                                                              | none                                                 |
| Polar unreachable or 5xx while creating a checkout           | the attempt stays counted: its outcome is unknown, and it blocks the organization's deletion until an operator checks | runbook "Stuck checkout attempts"                    |
| A price Polar doesn't have                                   | 503 "This price is not available yet"                                                                                 | none                                                 |
| Webhook without its secret, or not in Polar mode             | 503                                                                                                                   | `billing.webhook.unconfigured`                       |
| Webhook signature invalid / payload invalid                  | 400, nothing recorded                                                                                                 | `billing.webhook.bad_signature` / `.invalid_payload` |
| Polar unreachable while re-reading the subscription          | 503 so Polar retries; an already-applied delivery is acknowledged as `duplicate`                                      | `billing.webhook.provider_unavailable`               |
| Applying the event failed                                    | 500, nothing committed; Polar retries                                                                                 | `billing.webhook.failed`                             |
| Subscription not linked to this organization                 | recorded as `unlinked`, never applied (metadata and external id must both name the organization)                      | `billing.webhook.unlinked`                           |
| A price the policy doesn't sell                              | the subscription is recorded but grants only the default plan                                                         | `billing.webhook.unknown_price`                      |

## Retry safety

- **Webhooks** are idempotent: deduplicated by event id, and an older event than the one applied is `stale`. Polar's redelivery is safe (runbook "Re-sync one subscription from Polar").
- **Checkout** is not idempotent at Polar (no idempotency keys or conditional writes, ADR-0043). The billing page's buttons are disabled only until hydration, not while a request is pending, so a second click can start a second attempt and session (read from the source, not reproduced). One subscription per organization is enforced when a subscription exists, not while sessions are open.
- **Owner changes** call Polar before (revoke) and after (grant) the change. A failed revoke refuses the change; a failed grant leaves less access, repaired by the next checkout or portal call (ADR-0022, ADR-0043).

## Tests and operations

- Tests: [`polar.test.ts`](../../apps/app/test/polar.test.ts) (adapter and webhook), [`billing.test.ts`](../../apps/app/test/billing.test.ts) (policy, limits, checkout, portal, gates), [`organization-delete.test.ts`](../../apps/app/test/organization-delete.test.ts), [`account-deletion.test.ts`](../../apps/app/test/account-deletion.test.ts), [`e2e/billing.spec.ts`](../../apps/app/e2e/billing.spec.ts).
- Runbooks: ["Polar"](../runbooks/README.md#polar-adr-0022-adr-0018-adr-0020) (setup and go-live checks), ["Re-sync one subscription from Polar"](../runbooks/README.md#re-sync-one-subscription-from-polar), ["Stuck checkout attempts"](../runbooks/README.md#stuck-checkout-attempts).
- Concepts: [domain model: billing lifecycle](../architecture/domain-model.md#billing); UI: [billing handoffs](../design-system/patterns/billing-handoffs.md).
