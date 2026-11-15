# Billing handoffs

The person leaves the app for Polar's checkout or portal and comes back. What they see must come from the app's own state, never from the fact that they came back ([billing](../../integrations/billing.md#four-states-that-are-not-the-same-thing)).

## Context and prerequisites

The billing page ([`t.$tenant.billing.tsx`](../../../apps/app/src/routes/t.$tenant.billing.tsx)) shows the plan's name and the subscription's status, the renewal or end date, and usage against the plan's limits. Owners see "Upgrade to …" (one button per price, with the trial length when the organization has never subscribed) or "Manage billing"; admins see the page with "Only the organization owner can change the plan."; members don't see Billing in the nav. Plans, prices, trial and which statuses keep access come from [`policy.ts`](../../../apps/app/src/modules/billing/policy.ts) (ADR-0020); the page shows them and decides nothing.

## Action and pending

Upgrade and Manage billing ask the server for a Polar URL, then the browser goes there (`window.location.assign`). **Gap:** the buttons are disabled only until hydration, so a second click can start a second checkout attempt; each attempt is counted against deletion until its outcome is known (ADR-0043).

Before leaving, the page already names the organization (the tenant header) and the action on the button. Polar's checkout is labelled with the organization's name as the billed customer.

## Result: returning

| Return                                   | What the app knows                                                        | What the page shows (Current)                           |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| After paying, before the webhook arrives | nothing new                                                               | the old plan (Free)                                     |
| After the webhook was applied            | the new subscription and its status                                       | the new plan, "(trialing)" or "(active)", "Renews on …" |
| From the portal after cancelling         | the webhook may not have arrived; a cancellation is usually at period end | the plan until the webhook, then "Ends on …"            |
| After closing checkout without paying    | nothing                                                                   | the old plan                                            |

The success URL carries `?checkout=success`; the page doesn't read it, and it must never grant anything (Rule: entitlements decide, invariant 6).

**Gap and Proposal** (research scenario 5): there's no "checking for your payment" state, so a person who just paid sees the old plan with no explanation. A return state should say that the change can take a moment and offer a reload, using the marker only to choose the wording, never to show the new plan. Not implemented.

## Failure and unknown outcome

- Refusals before leaving are form-level alerts: already subscribed ("Use Manage billing."), being deleted, billing closed for the account, billing not configured, price not available.
- A request to Polar that didn't answer has an unknown outcome: no message can say whether a session exists; the attempt stays counted (runbook "Stuck checkout attempts").
- If the plan doesn't change after a while, it's an operator task ([troubleshooting](../../troubleshooting/README.md#checkout-returned-but-access-is-unchanged)), not a second checkout.

## Delayed and scheduled effects

A cancellation at period end keeps the plan until the date shown ("Ends on …"); a failed renewal keeps a paid plan while Polar retries (`past_due` is entitled) and falls back when the policy says so. Show the date the policy and subscription give; never compute an effective date in the page.

## Focus and announcements

Errors are a `FieldError` (`role="alert"`) under the buttons. The return is a full page load; focus starts at the page (Not verified).
