# ADR-0043: A database guard keeps an owner; a claim plus the provider's state guards deletion

Status: Proposed · Date: 2026-10-31

## Context

The organization settings feature (roadmap, "Parallel track: Starting kit") adds leave, transfer and delete. Two check-then-write gaps were investigated first.

**Owners.** Better Auth 1.7.12 counts owners on a read separate from its write, and doesn't count at all when one owner demotes another. Reproduced over its real HTTP handler on 55fd9cf, 20 pairs each, as two owners of one organization: demoting each other, demoting themselves, both leaving, removing each other, and one leaving while the other demotes themselves all answered 200/200 and left **zero owners, 20 of 20**. No Better Auth hook runs at the write, and these endpoints are directly reachable, so a check in the app can't hold the condition.

**Deletion.** ADR-0020 refuses to delete an organization with a live subscription, but reads only our row, which only webhooks write. Payment can complete before its webhook arrives. A checkout session already issued can be paid after the check. A new checkout can start between the check and the delete. The webhook then answers `unlinked` for an organization that no longer exists, and the customer has paid for nothing. Polar (API 2026-04) has no call to cancel or expire a checkout session, and neither `CheckoutCreate` nor `CheckoutUpdate` sets its expiry.

**The freeze.** The roadmap freezes new security ADRs, except for "a finding that is proven and within the current milestone's scope". The owner race is proven above and this feature is on the approved track; the deletion race comes from the owner's instruction not to accept it. This ADR is written as that exception, and accepting it is the owner's decision at merge. It's a new ADR, not ADR-0022 Notes, because every other SQL-only object family has its own (ADR-0039, ADR-0040) and this is a new integrity rule on tables Better Auth writes.

## Decision

### 1. The owner guard

`member_keeps_owner`: a deferred constraint trigger on `member`, firing on `UPDATE` or `DELETE` of a row whose old role includes `owner`. It locks the organization row (`FOR NO KEY UPDATE`, the mode `applyBillingEvent` and `createWithinLimit` use), then counts owners, reading `role` as the capability matrix does (`(^|,)\s*owner\s*(,|$)`), and fails the commit with SQLSTATE `23514` if the organization still exists and has none.

**It guarantees:** a transaction that demotes, removes or moves an owner's row can't commit at READ COMMITTED leaving an existing organization with no owner, whichever path made it: a server function, a Better Auth endpoint, or SQL by a role that can't disable triggers.

**How it holds.** At READ COMMITTED each statement in the function takes a new snapshot, so a second commit waiting on the lock counts after the first's commit. Autocommit statements behave the same: a deferred trigger fires at the statement's own commit. An organization deleted in the same transaction passes, whatever the order.

**Isolation.** Every path here runs at READ COMMITTED, Postgres's default; nothing in the repository sets another level. At REPEATABLE READ the count reads the transaction's old snapshot, and the lock alone doesn't help: without a guard, the same interleaving reached zero owners, 20 of 20. So the function refuses anything but READ COMMITTED with SQLSTATE `25000`, failing closed. SERIALIZABLE would have been safe (it aborted one transaction, 20 of 20) but is refused too, so there's one rule to reason about.

**It doesn't cover:**

- **Creating an organization.** Better Auth inserts the organization and its owner in two separate statements with no transaction, so a check at commit would refuse every creation. A crash between them leaves an ownerless organization that no member can reach. The guard can't fix this without replacing Better Auth's endpoint; accepted.
- **Organizations that already have no owner.** It only fires on an owner's row. Before release, the owner confirms production has none.
- **`INSERT`** (can't remove an owner), and **`TRUNCATE`**.
- **A role that can disable triggers**: the table owner or `session_replication_role`. `app_runtime` can do neither (ADR-0038).

**Side effects.** A concurrent promotion isn't visible until it commits, so a demotion can be refused when it would have been safe: never no owner, sometimes a retry. Two transactions can deadlock on the member and organization rows; Postgres aborts one, which fails closed. Cascading a user's deletion is refused while they're the sole owner, unless the organization goes in the same transaction: the data subject path (roadmap, account deletion) has to handle it.

**The refused request.** With `isOwnerGuardViolation`, server functions answer 409. Direct `/api/auth/organization/*` answers a 500 with no detail, because the refusal is a database error at commit, and Better Auth wraps those.

ADR-0022's hooks still run, and their order can't change: the revoke runs before the write the guard may refuse. So the loser of a race can keep the owner role without billing access, repaired by the next checkout or portal call. That fails toward less access, as ADR-0022 accepts.

### 2. The deletion gate

`billing_checkout_gate`: one row per organization, with two timestamps. They're claims, each honored for `BILLING_CLAIM_SECONDS` (300). The database holds no billing policy: the app decides what's live (`isLive`), and the database only serializes who goes first.

- **Checkout:** after the existing checks and before calling the provider, one conditional upsert sets `checkout_started_at`, unless a deletion claim is unexpired. Refused: 409, and the provider is never called.
- **Deletion,** in Better Auth's `beforeDeleteOrganization`, after its permission check, so every path is covered:
  1. One conditional upsert sets `deletion_started_at`, unless a checkout claim is unexpired. Refused: 409.
  2. Read the provider: every subscription for the customer, and its checkout sessions. Polar's `open` unexpired, `confirmed`, and `succeeded` in the last 10 minutes count as pending.
  3. Live by `isLive`, on our row or the provider's, or a pending checkout: 409. Provider unreadable: 503.
  4. Remove the provider's customer (ADR-0022), then Better Auth deletes the organization.

Each upsert is the condition held in the write: the row lock makes the second claimant re-read the first's claim, so of a checkout and a deletion, one is refused.

A claim is never released, only renewed or expired. Several deletions can share it (a second owner, a retry after a failed delete), and one that gives up can't know whether another still relies on it. An earlier design released on refusal, and review showed a failed attempt reopening checkouts behind a deletion still in progress. The cost: a refused or failed deletion blocks that organization's new checkouts for up to 5 minutes.

| Case                                                         | What happens                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| New checkout during a deletion                               | Refused by the claim                                                           |
| Checkout on its way to the provider, session not visible yet | Its claim refuses the deletion for 5 minutes                                   |
| Session already issued, unpaid                               | Pending: deletion refused until it expires or completes; it can't be cancelled |
| Paid, webhook not delivered                                  | The provider's subscription is read directly: refused                          |
| Webhook delivered late, after a legitimate deletion          | `unlinked`, acknowledged and logged; only ended subscriptions can get here     |
| Request crashes after claiming                               | The claim expires; checkouts wait at most 5 minutes                            |
| Delete fails after the claim, or a second owner deletes      | The claim is shared and renewed, and a retry proceeds                          |
| Deletion refused, or the provider is unreadable              | The claim stays, and new checkouts wait for it to expire                       |
| Polar unreachable                                            | 503 and nothing changes                                                        |

**Limits, not closed here:**

- It trusts Polar's list APIs to reflect a confirmed payment at once, and that a succeeded checkout's subscription appears within 10 minutes; neither is measured. `apps/app/eval/polar-provider.test.ts` asserts the read against the sandbox; the owner runs it before live billing.
- A request that outlasts the claim could let a checkout in behind it. Worker requests calling Polar should take seconds, and a claim lasts 5 minutes.
- An owner can be blocked until an abandoned session expires, for as long as Polar keeps it open. There's no way to shorten that.
- Removing the provider's customer before a database failure can't be undone (ADR-0022): a retry deletes the rest.

## Alternatives

- **Disable Better Auth's member endpoints and write our own with conditional updates (as #225 did for non-owners).** Rejected: ADR-0022 requires owner changes to go through its hooks, and it would replace the part of the library this project relies on.
- **A lock taken in middleware.** Rejected: a Worker request has no transaction spanning Better Auth's statements, and session-level advisory locks don't survive Hyperdrive's pooling.
- **SERIALIZABLE for owner changes.** Rejected: Better Auth's adapter doesn't set a level, and every retry path would need handling. The check would still be in the database.
- **Trusting the webhook, or a lock around it.** Rejected: payment can complete before delivery, so no lock around delivery closes the gap.
- **Encoding "live" in SQL so a trigger can refuse the delete.** Rejected: billing policy stays in `policy.ts` (ADR-0020), and the provider's state isn't in the database anyway.

## Consequences

- A new SQL function and trigger, registered in `packages/db/sql-only-objects.tsv`, and a new tenant table with its grant and archive trigger. A restored gate row isn't needed: a missing row means no claim.
- Deleting an organization in Polar mode makes two more provider calls, and fails closed if they fail. The token's existing scopes cover them (`subscriptions:read`, `checkouts:write`).
- Rollback of the app alone is safe: old code ignores the gate, and the guard only refuses what would leave no owner.
