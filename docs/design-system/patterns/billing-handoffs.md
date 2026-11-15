# Billing handoffs

The person leaves the app for Polar's checkout or portal and comes back. What they see must come from the app's own state, never from the fact that they came back ([billing](../../integrations/billing.md#four-states-that-are-not-the-same-thing)).

## Context and prerequisites

The billing page ([`t.$tenant.billing.tsx`](../../../apps/app/src/routes/t.$tenant.billing.tsx)) shows the plan's name and the subscription's status, the renewal or end date, and usage against the plan's limits. Owners see "Upgrade to …" (one button per price, with the trial length when the organization has never subscribed) or "Manage billing"; admins see the page with "Only the organization owner can change the plan."; members don't see Billing in the nav. Plans, prices, trial and which statuses keep access come from [`policy.ts`](../../../apps/app/src/modules/billing/policy.ts) (ADR-0020); the page shows them and decides nothing.

## Action and pending

Upgrade and Manage billing ask the server for a Polar URL, then the browser goes there (`window.location.assign`). From the first click the buttons are disabled ("Opening Polar…") and stay so while the browser leaves; a page restored by Back from Polar enables them again (Current). That prevents a second attempt from this page only: another tab can still start one, and each attempt is counted against deletion until its outcome is known (ADR-0043; server-side deduplication isn't built, owner 2026-11-15).

Before leaving, the page already names the organization (the tenant header) and the action on the button. Polar's checkout is labelled with the organization's name as the billed customer.

## Result: returning

Polar's success URL carries `?checkout=success` and the portal's return URL `?portal=return`. A marker only chooses the page's wording; the plan, status and dates always come from the overview, and nothing is granted by a return (Rule: entitlements decide, invariant 6). Behaviour approved by the owner, 2026-11-15 (Current, [`t.$tenant.billing.tsx`](../../../apps/app/src/routes/t.$tenant.billing.tsx)):

| Return                                   | What the app knows                                                        | What the page shows                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| After paying, before the webhook arrives | nothing new                                                               | the old plan, "Checking for your new plan. This can take a moment."; the overview is read again after 2, 3, 5, 8 and 12 s; Upgrade disabled |
| The webhook applied during the wait      | the overview's `live` (policy's `isLive`)                                 | the new plan, "Your plan is now <plan>."; the marker is removed, so reload and Back don't wait again                                        |
| Still unchanged after the wait           | nothing new                                                               | "Your new plan isn't showing yet. If you completed the payment, … don't start another checkout. …", "Check again"                           |
| A read failed                            | nothing new                                                               | the last loaded plan; at the end of the wait, "We couldn't check for an update just now.", "Check again"                                    |
| From the portal                          | the webhook may not have arrived; a cancellation is usually at period end | a fresh read on arrival; "Changes you made in Polar can take a moment to show here.", "Check again"; no automatic wait                      |
| After closing checkout without paying    | nothing (the cancel URL has no marker)                                    | the old plan                                                                                                                                |

- **The end of the wait** only ends the page's waiting: it means "still waiting for an update", never that a payment failed, and it changes no entitlement, checkout attempt or deletion gate (ADR-0043).
- **Check again** is one read; it restarts nothing (only reloading the page with the checkout marker restarts the wait).
- **Leaving the page** cancels the next read; one in flight finishes and its answer is dropped.
- **Back from Polar** that restores the page from the browser's cache reads once more.

## Failure and unknown outcome

- Refusals before leaving are form-level alerts: already subscribed ("Use Manage billing."), being deleted, billing closed for the account, billing not configured, price not available.
- A request to Polar that didn't answer has an unknown outcome: no message can say whether a session exists; the attempt stays counted (runbook "Stuck checkout attempts").
- If the plan doesn't change after a while, it's an operator task ([troubleshooting](../../troubleshooting/README.md#checkout-returned-but-access-is-unchanged)), not a second checkout; the delayed message says so.

## Delayed and scheduled effects

A cancellation at period end keeps the plan until the date shown ("Ends on …"); a failed renewal keeps a paid plan while Polar retries (`past_due` is entitled) and falls back when the policy says so. Show the date the policy and subscription give; never compute an effective date in the page.

## Focus and announcements

Errors are a `FieldError` (`role="alert"`) under the buttons. The return state is a `role="status"` region rendered with the page, so its changes are announced politely; focus stays where it is (Not verified with a screen reader). The return is a full page load; focus starts at the page (Not verified).
