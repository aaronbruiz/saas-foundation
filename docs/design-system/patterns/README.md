# Patterns

A pattern covers a whole task, not a component: what the person knows before acting, the action, the wait, the result, what happens when it fails or the outcome is unknown, interruptions, and where focus goes and what's announced. A good dialog alone doesn't cover that.

Each pattern page uses the same sections and marks every statement as **Rule** (with its source), **Current** (what the app does, with its file), **Proposal** (needs a decision before anyone relies on it) or **Gap** (observed, not fixed). Gaps are candidates for separate changes; none is fixed by these pages.

| Pattern                                                 | Covers                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Destructive actions](destructive-actions.md)           | deleting, removing, revoking, leaving, transferring ownership                |
| [Saving and submitting](saving-and-submitting.md)       | pending state, repeated clicks, unknown outcomes, unsaved work, completion   |
| [Errors and recovery](errors-and-recovery.md)           | field and form errors, page failures, stale pages and concurrent changes     |
| [Loading and empty states](loading-and-empty-states.md) | loading, none yet, no results, unavailable                                   |
| [Invitations and access](invitations-and-access.md)     | invitations, identity, permissions and limits, session expiry, changed roles |
| [Billing handoffs](billing-handoffs.md)                 | leaving for the provider, returning, delayed and scheduled effects           |

## Research coverage

[`docs/research/ux-scenario-patterns.md`](../../research/ux-scenario-patterns.md) (2026-11-14) lists twelve scenario families as candidates for review. It's research, not policy: each family is mapped here, and its candidate rules stay proposals unless a page cites an existing rule for them.

| Research scenario                          | Where it's covered                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Saving, waiting, unknown outcome        | [saving and submitting](saving-and-submitting.md)                                                                                                                                             |
| 2. Unsaved work, cancel, interruption      | [saving and submitting](saving-and-submitting.md#interruption-and-unsaved-work); [settings](../page-patterns/settings.md), [collection and detail](../page-patterns/collection-and-detail.md) |
| 3. Recovery from errors                    | [errors and recovery](errors-and-recovery.md)                                                                                                                                                 |
| 4. Invitations and identity                | [invitations and access](invitations-and-access.md)                                                                                                                                           |
| 5. Billing handoff, delayed effects        | [billing handoffs](billing-handoffs.md)                                                                                                                                                       |
| 6. Empty, loading, unavailable, no results | [loading and empty states](loading-and-empty-states.md)                                                                                                                                       |
| 7. Permissions, prerequisites, limits      | [invitations and access](invitations-and-access.md#permissions-prerequisites-and-limits); limits from [`policy.ts`](../../../apps/app/src/modules/billing/policy.ts)                          |
| 8. Stale pages, concurrent changes         | [errors and recovery](errors-and-recovery.md#stale-pages-and-concurrent-changes); conflict detection deferred                                                                                 |
| 9. Session expiry, reauthentication        | [invitations and access](invitations-and-access.md#session-expiry), [authentication](../page-patterns/authentication.md); new challenges deferred                                             |
| 10. Completion and what happens next       | each pattern's "Result" section                                                                                                                                                               |
| 11. Accessible changes of state            | each pattern's "Focus and announcements" section; [accessibility](../foundations/accessibility.md)                                                                                            |
| 12. Creation scope, consequential defaults | [collection and detail](../page-patterns/collection-and-detail.md), [onboarding](../page-patterns/onboarding.md)                                                                              |

**Deferred** until a product feature needs them (with tenant-data and policy decisions first): bulk operations, search and filters, import and export, long-running or delegated jobs, durable drafts, richer conflict resolution, new authentication challenges.

## Review cases

When a pattern is applied to a page, walk these cases where they apply and record the result in the PR's Checks: a slow response; a repeated click; a response lost after a write that may have succeeded; Back and reload; an expired session; a role changed while the page is open; keyboard-only use.

## Other sources

Primer's [scenario patterns](https://primer.style/product/) (Create, Delete, Edit, Delegate) and UI patterns (Saving, Loading, Empty states, Degraded experiences), read 2026-11-15, are the structural model; GOV.UK, Carbon and WCAG Understanding documents are cited where the research note uses them. They describe other organizations' choices; where a page cites them it's for the reasoning, and our rules win.
