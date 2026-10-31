# ADR-0043: A database guard keeps an owner; a claim plus the provider's state guards deletion

Status: Accepted for the smoke-test-only environment, with conditions (owner 2026-10-31) · Date: 2026-10-31

Owner 2026-10-31: supports decision 1 and documenting it here with an explicit freeze exception; approves decision 2 for the current smoke-test-only environment, on the conditions below. This approves the bounded design, not a merge or a deployment. Anything beyond that environment comes back to the owner.

## Context

The organization settings feature (roadmap, "Parallel track: Starting kit") adds leave, transfer and delete. Two check-then-write gaps were investigated first.

**Owners.** Better Auth 1.7.12 counts owners on a read separate from its write, and doesn't count at all when one owner demotes another. Reproduced over its real HTTP handler on 55fd9cf, 20 pairs each, as two owners of one organization: demoting each other, demoting themselves, both leaving, removing each other, and one leaving while the other demotes themselves all answered 200/200 and left **zero owners, 20 of 20**. No Better Auth hook runs at the write, and these endpoints are directly reachable, so a check in the app can't hold the condition.

**Deletion.** ADR-0020 refuses to delete an organization with a live subscription, but reads only our row, which only webhooks write. Payment can complete before its webhook arrives. A checkout session already issued can be paid after the check. A new checkout can start between the check and the delete. The webhook then answers `unlinked` for an organization that no longer exists, and the customer has paid for nothing. Polar (API 2026-04) has no call to cancel or expire a checkout session, and neither `CheckoutCreate` nor `CheckoutUpdate` sets its expiry.

**The freeze.** The roadmap freezes new security ADRs, except for "a finding that is proven and within the current milestone's scope". The owner race is proven above and this feature is on the approved track; the deletion race comes from the owner's instruction not to accept it. This ADR is written as that exception. It's a new ADR, not ADR-0022 Notes, because every other SQL-only object family has its own (ADR-0039, ADR-0040) and this is a new integrity rule on tables Better Auth writes.

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

**What Polar can't do.** It has no idempotency keys, no conditional writes, and no call to cancel or expire a checkout session (API 2026-04). So once a create request has left, nothing on our side can prove it won't still land: not a timeout, not an abort, not time passing. The design therefore uses no clock for safety. It only goes ahead on what it can prove, and otherwise refuses.

`billing_checkout_gate`: one row per organization.

- **Checkout.** Before anything reaches the provider, one conditional upsert raises `checkout_generation` and `checkouts_in_flight`, unless `removal_started_at` is set (409; the provider is never called). When the outcome is known, the count comes down: the session exists, or the attempt can never exist (nothing was sent to create it, or Polar answered 4xx). A network error or a 5xx on the create is unknown, and stays counted.
- **Deletion,** in Better Auth's `beforeDeleteOrganization`, after its permission check, so every path is covered:
  1. Read the gate. Removal already committed: go ahead (a retry). Anything in flight: 409.
  2. Read the provider: every checkout session first, then every subscription. Live by `isLive`, on our row or the provider's, or a session that could still complete: 409. Unreadable: 503.
  3. Commit: one conditional upsert sets `removal_started_at`, only if the generation is unchanged and nothing is in flight. Otherwise 409.
  4. Remove the provider's customer (ADR-0022), then Better Auth deletes the organization.

**Why that's enough.** With none in flight at step 1, every session that will ever exist from earlier attempts already exists, so step 2 sees them. The generation check proves none started during step 2, however long it took, and after the commit none can start. Nothing here expires, so a request paused at any point either fails its commit or finds checkouts closed.

**Reading the provider.** Sessions are read first, with no status filter, so a session finishing mid-read can't shift a page. Polar breaks no ties when sorting, so items with equal timestamps could repeat and push another out of a page: each list must reach the total Polar reports, or the read fails (503). A finished session can't change, so the subscriptions read afterwards include what they produced. Only `expired`, or `succeeded` with a subscription whose `checkout_id` is that session's, counts as finished. Everything else blocks, including `failed` and any future status, and with no settling window.

The database holds no billing policy: the app decides what's live (`isLive`), and the row only orders checkouts against deletion. A refused deletion changes nothing, so it costs checkouts nothing.

| Case                                                       | What happens                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| New checkout after the commit                              | Refused; the provider isn't called                                                        |
| Checkout paused on its way to the provider, for any time   | In flight: deletion refused until it resolves                                             |
| Deletion paused on a provider read while a checkout starts | Its commit fails                                                                          |
| Session issued, unpaid, or payment in progress             | Refused until Polar says it's finished                                                    |
| Payment completes between the two reads                    | Seen as `open`: refused. Seen as `succeeded`: its subscription must be listed, or refused |
| Paid, webhook not delivered                                | Read from the provider: refused                                                           |
| Request crashes after the commit                           | Checkouts stay closed; retrying the deletion finishes it                                  |
| Request crashes before the commit                          | Nothing changed                                                                           |
| Checkout's outcome unknown (crash, network error)          | Refused; only an authorized override clears it                                            |
| Polar unreachable                                          | 503, nothing changes                                                                      |

**The limitation that remains.** An attempt whose outcome is unknown blocks that organization's deletion, indefinitely. Clearing it is a risk override, not recovery (runbook, "Stuck checkout attempts"): checking Polar is a judgment, not a proof, because a request that never answered could in principle land afterwards. If it did, a customer could pay for a deleted organization; the webhook would answer `unlinked` and log it. Closing this needs a provider feature (idempotency, or a way to cancel a session) or a compensating action, such as revoking and refunding on `unlinked`, which is a policy decision and isn't built here.

A session that never reaches a finished status would also block deletion, with no operator step to clear it. Whether Polar always moves `open` and `failed` to `expired` is a release gate below.

**Operating constraints.** Two things the gate can't see, which operators work within. **A database restore** can lose an in-flight count or a commit made after the restore point, while the request it counted can still land: after a restore, treat checkouts since the restore point as unknown (runbook). **Anything outside the app**, such as a subscription created in Polar's dashboard or API after the read, isn't ordered by the gate; only the app creates sessions, and only by this path, so don't create subscriptions for an organization outside the app while it may be deleted.

### Conditions of acceptance (owner, 2026-10-31)

1. Unknown checkout outcomes block deletion. An operator clearing one is a separate, explicitly authorized risk override, not normal recovery.
2. No automatic subscription revocation or refund is built here. Compensation and recovery policy are decided before live billing.
3. The Hyperdrive and Polar sandbox gates below stay release gates. If either exposes a broken assumption, the implementation is corrected before release.
4. **Live billing (`POLAR_SERVER=production`) stays blocked** until unknown outcomes, unfinished sessions and operator recovery have a reviewed policy.
5. The production check for ownerless organizations is deferred to release preparation. No production access is authorized by this acceptance.
6. The restore limitation and subscriptions created outside the app are the operating constraints above.

### Release gates

Neither is verified, and both must pass before this ships to production:

- **Hyperdrive.** The settings e2e against a preview, plus the owner races through the preview, with the trigger's refusals and the isolation assumption observed through Hyperdrive.
- **Real Polar, in the sandbox.** `apps/app/eval/polar-provider.test.ts` for session visibility, plus a paid checkout showing that: a session is listed as soon as its create answers; a paid session's subscription has its `checkout_id`, and appears in the list by customer; abandoned `open` and `failed` sessions reach `expired`; and the portal can't start a subscription for a customer without a live one.

### Freeze exception

The roadmap records it. It covers the proven owner race and this gate, on the conditions above.

## Alternatives

- **Disable Better Auth's member endpoints and write our own with conditional updates (as #225 did for non-owners).** Rejected: ADR-0022 requires owner changes to go through its hooks, and it would replace the part of the library this project relies on.
- **A lock taken in middleware.** Rejected: a Worker request has no transaction spanning Better Auth's statements, and session-level advisory locks don't survive Hyperdrive's pooling.
- **SERIALIZABLE for owner changes.** Rejected: Better Auth's adapter doesn't set a level, and every retry path would need handling. The check would still be in the database.
- **Trusting the webhook, or a lock around it.** Rejected: payment can complete before delivery, so no lock around delivery closes the gap.
- **Timed claims with a longer timeout or a settling window.** The first version of this ADR's gate. Rejected: an expired operation can still complete, and a window proves nothing about remote work. Releasing a claim on refusal also let a failed attempt reopen checkouts behind a deletion in progress.
- **Encoding "live" in SQL so a trigger can refuse the delete.** Rejected: billing policy stays in `policy.ts` (ADR-0020), and the provider's state isn't in the database anyway.

## Consequences

- A new SQL function and trigger, registered in `packages/db/sql-only-objects.tsv`, and a new tenant table with its grant and archive trigger. The gate row is safety state: restoring a single organization from the archive doesn't need it (its deletion had finished, and its customer is gone), but a database restore can roll it back, as above.
- Deleting an organization in Polar mode reads two more provider lists, and fails closed if they fail. The token's existing scopes cover them (`subscriptions:read`, `checkouts:write`).
- After the commit, an organization whose deletion crashed can't buy until the deletion is retried: the customer may already be gone.
- Rollback of the app alone is safe: old code ignores the gate, and the guard only refuses what would leave no owner.
