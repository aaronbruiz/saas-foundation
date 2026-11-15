# UX scenario patterns beyond destructive actions

Research date: 2026-11-14. Source inspection: `5fb035fdc60536408a795c2955652160d52f85d4`.

This is a research inventory, not an approved implementation plan or a change to product policy. It identifies scenarios to review; it does not claim that every scenario is missing. No rendered UI, assistive-technology, or usability testing was performed for this note. Roadmap priorities and existing authorization, tenancy, billing, and retention decisions still apply.

## What the sources establish

Design-system guidance describes an organization's recommended interaction patterns; it is not a universal standard. Product documentation demonstrates real lifecycle cases, but its policies should not be copied automatically. WCAG success criteria are standards requirements when targeting that conformance level; their Understanding documents explain them and are informative.

For the original deletion sources, prefer the [published Primer delete pattern](https://primer.style/product/scenario-patterns/delete/) over the supplied preview URL, which the coordinating session could not retrieve. Community discussion threads are reports of individual experiences, not normative guidance. [WCAG 3.3.4](https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html) offers reversible, checked, or confirmed alternatives for the transactions it covers; it does not require a confirmation dialog for every action. The coordinating session verified these source qualifications.

The useful unit of review is a complete scenario: what starts it, what the person knows before acting, what happens while waiting, how it ends, what happens if interrupted, and how they recover. A good dialog alone does not cover that lifecycle.

## Priority scenarios

### 1. Saving, waiting, and an unknown outcome

**Scenario:** someone submits a change, receives no clear feedback, then clicks again or refreshes.

Primer recommends visible progress on submit and confirmation when the saved result is not already evident. Longer delegated work should have persistent status rather than hold people in a spinner. [Primer saving](https://primer.style/product/ui-patterns/saving/), [Primer delegate](https://primer.style/product/scenario-patterns/delegate/).

**Candidate rule:** distinguish idle, submitting, confirmed success, confirmed failure, and outcome unknown. Prevent repeated submission while the same request is pending. A connection failure does not establish that the server did nothing; reconcile the result before offering a retry that could duplicate an operation. This last rule is an engineering/UX inference, not a quoted Primer requirement. Button disabling alone is not server-side deduplication.

**Local candidate:** project creation, project saving, invitation acceptance, and billing actions disable their buttons for hydration but do not consistently represent an in-flight action. Settings/account/auth already contain busy-state patterns that can inform consistency.

### 2. Unsaved work, cancel, and interruption

**Scenario:** someone edits a name or longer content, switches organization, closes a dialog, presses Back, or refreshes.

Primer's edit guidance calls for a visible cancel action, restoring the previous value on cancel, protecting meaningful unsaved work, preserving failed edits, and local drafts where loss would be costly. [Primer edit](https://primer.style/product/scenario-patterns/edit/).

**Candidate rule:** choose a save model per form, make Save/Cancel scope explicit, and decide which interruptions warrant a discard warning. Avoid warning when nothing changed. Draft persistence for future long content needs an explicit privacy/storage decision; never apply it indiscriminately to passwords or secrets.

**Local candidate:** project editing has no dirty-state navigation guard. This matters more when the template grows beyond a short name field.

### 3. Recovery from errors

**Scenario:** an input is wrong, a service is unavailable, access changed, or a save conflicts with another person's work.

GOV.UK distinguishes input validation from eligibility/permission failures, preserves entered answers, and makes errors actionable. Its precise error-summary and validation-timing conventions belong to its own system. [GOV.UK validation](https://design-system.service.gov.uk/patterns/validation/).

**Candidate rule:** use field errors for correctable input, a persistent form-level message for a failed operation, and a page-level recovery path when the task cannot continue. Explain what the person can do, preserve safe input, and avoid an undifferentiated “try again” for every failure.

**Local coverage:** the router already has a shared `ErrorPage`; the question is recovery for specific operations, not absence of global error handling. Existing `FieldError`, form alerts, and success-only toasts provide a base.

### 4. Invitations and identity

**Scenario:** an invitation is opened while signed into another account, after expiry, after acceptance, or after revocation; the sender assumes an email sent means membership exists.

GitHub distinguishes a pending invitation from membership, verifies the invited email against the accepting account, and provides expired-invitation retry/cancel paths. Its seven-day expiry is a GitHub policy, not a recommendation for this product. [GitHub invitations](https://docs.github.com/en/organizations/managing-membership-in-your-organization/inviting-users-to-join-your-organization).

**Candidate review:** make the signed-in identity and authorized acceptance context understandable, cover sender and recipient recovery, and distinguish “invited” from “joined.” Give a useful path to sign in with the intended account or seek a fresh invitation without revealing invitation validity to an unauthorized visitor.

**Local constraint:** the acceptance loader currently returns the signed-in email, not an organization preview. The service intentionally merges wrong-recipient, expired, unknown, and used invitations into 404. Any context preview or differentiated failure would need owner-approved authorization/tenant-data decisions; this research does not authorize them.

### 5. Billing handoff and delayed effects

**Scenario:** checkout opens elsewhere; the person returns before the application has received the update, closes the portal, or requests a change that takes effect later.

Stripe's pending-update documentation explicitly distinguishes pending from failed, and notes that payment success and applying a subscription change need not complete in the same request. This is a product/API example of a lifecycle, not evidence that Polar has the same semantics. [Stripe pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates).

**Candidate review:** before leaving, identify the organization and action; after returning, distinguish “checking,” applied, scheduled, canceled, and failed using authoritative application state. Show the effective date and the next available action when policy supplies them. Do not treat arriving at a return URL as proof of payment or entitlement.

**Local constraint:** Polar remains the provider and `billing/policy.ts` remains the policy authority. Any change to limits, trial, cancellation, or downgrade effects requires the existing approval process.

**Local candidate:** checkout configures a return URL containing `?checkout=success`, while the billing route does not consume that search marker or render a dedicated processing/return state. The marker alone must not authorize access.

### 6. Empty, loading, unavailable, and no results

**Scenario:** an organization switcher or project list is blank, but the reason may be “loading,” “none yet,” “filtered out,” or “failed.”

Carbon separates no-data, user-action, and error-management empty states, with different explanations and recovery actions. [Carbon empty states](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states).

**Candidate rule:** never present loading or failed retrieval as a true empty collection. For first use, provide the next permitted action; for no results, offer filter/search adjustment; for a load failure, offer appropriate recovery. Keep the treatment proportional to the available space.

**Local candidate:** the organization menu begins with `others=[]` during retrieval without a distinct loading indication. Existing empty-state components do not by themselves settle which state to show.

### 7. Permission, prerequisites, and limits

**Scenario:** a member sees an unavailable action but cannot tell whether it needs an owner, an upgrade, a prerequisite, or simply more time.

Carbon distinguishes temporarily disabled, read-only, and hidden controls; it recommends explaining how an important temporary block can be resolved. [Carbon disabled states](https://www.carbondesignsystem.com/building-blocks/core/patterns/disabled-states).

**Candidate rule:** pick the representation based on the reason. For an authorized member, explain an actionable prerequisite or plan limit with a valid next step. Hide irrelevant controls where appropriate. Avoid treating a disabled button or a hover-only tooltip as the entire explanation.

**Local constraint:** another tenant's resources, unknown tenants, and non-members remain indistinguishable 404s. Helpful copy must not reveal protected existence. UI explanations never replace server authorization.

### 8. Stale pages and concurrent changes

**Scenario:** two people edit the same record; a member's role changes while their form is open; the selected resource disappears.

Primer explicitly recommends detecting changes made by someone else and surfacing the conflict before overwriting them. [Primer edit](https://primer.style/product/scenario-patterns/edit/).

**Candidate review:** preserve the attempted safe edit, explain that the underlying state changed, and offer an explicit reconciliation route. Refreshing blindly can destroy work. Conflict semantics are a product/data decision, not just an error-message change. No absence of concurrency protection was established by this research.

### 9. Session expiry and reauthentication

**Scenario:** someone starts a task while signed in, then must authenticate again before completion.

GitHub uses reauthentication for protected high-impact actions even in an existing signed-in session. Its particular actions and timeout are product choices. [GitHub sudo mode](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode).

**Candidate review:** explain why authentication is needed and where the person will return; preserve only safe task context and re-check authorization before continuing. Do not silently replay a consequential submission after login. This is a review topic, not a recommendation to add a blanket password prompt.

### 10. Completion and what happens next

**Scenario:** a request was accepted, but the person does not know whether the overall task is done, when its effects start, or where to find the result.

GOV.UK confirmation pages explain completion, next steps, timing, and relevant records; they also consider a user returning through a bookmark. [GOV.UK confirmation pages](https://design-system.service.gov.uk/patterns/confirmation-pages/).

**Candidate rule:** choose feedback proportional to the transaction. An updated visible name may be enough; invitation acceptance or an external billing handoff may need a persistent destination and clear next step. Do not announce a larger task as complete when only a request was received.

### 11. Accessible changes of state

**Scenario:** sighted users notice “Saved” or “No results,” while a screen-reader user receives no announcement; opening or closing an editor loses keyboard position.

WCAG 4.1.3 covers status messages that must be available to assistive technology without receiving focus. It does not require moving focus to every update. [WCAG status messages explanation](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

**Candidate review:** define focus destination and announcement behavior for loading, errors, successful saves, navigation, dialogs, and removal of the focused item. Verify the whole task with keyboard and assistive technology; the presence of an accessible primitive is insufficient evidence by itself.

### 12. Creation scope and consequential defaults

**Scenario:** “Create” produces something in an unintended organization, or a small form hides consequential visibility or ownership choices.

Primer matches inline/dialog/full-page creation to both complexity and consequence, recommends meaningful defaults, and asks that action labels name what is created. [Primer create](https://primer.style/product/scenario-patterns/create/).

**Candidate review:** make the active tenant and meaningful consequences legible before submission. For future copy, import, export, sharing, and bulk operations, define destination, inclusion/exclusion rules, partial success, and recovery when those features have a concrete trigger. They are not foundation requirements today.

## Suggested review order

1. Apply the saving/pending/outcome/recovery review to existing project, invitation, and billing actions.
2. Review navigation loss, invitation context, and billing-return states against existing policies.
3. Separate loading/empty/error states and verify focus/announcements across these same journeys.
4. Pull in concurrency, drafts, reauthentication, and bulk-operation patterns only when product scope and evidence justify them.

For each journey, record: entry context → prerequisites → action → pending → success → failure/unknown → interruption → recovery → focus/announcement. Include a slow response, duplicate click, lost response after a possible successful write, Back/refresh, expired session, changed role, and keyboard-only use in the review cases that apply.

## Local evidence and limits

Source-inspected candidates above were recorded by the coordinating session against the stated commit, with button-state and router coverage spot-checked by the research worker:

- `apps/app/src/routes/t.$tenant.projects.$id.tsx`: save awaits update and router invalidation; button disables for hydration.
- `apps/app/src/routes/t.$tenant.projects.index.tsx`: creation has the same hydration-only disabled condition.
- `apps/app/src/routes/invite.$id.tsx`: acceptance button has the same condition; invitation disclosure constraints require service-level review.
- `apps/app/src/routes/t.$tenant.billing.tsx`: billing buttons disable for hydration.
- `apps/app/src/router.tsx`: registers the shared `ErrorPage`.

These are starting points for review, not reproduced defects or evidence about production. No application behavior, approval rule, roadmap, or accepted ADR changed. Application checks and runtime tests were not run for this research note.
