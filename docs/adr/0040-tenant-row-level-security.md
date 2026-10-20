# ADR-0040: Tenant context per repository call and row-level security on tenant tables

Status: Proposed · Date: 2026-10-19

## Context

Every tenant read and write already filters by `ctx.orgId` inside a `packages/db` repository (AGENTS.md invariant 2, opaque `Db` since #78). One omitted `organization_id` filter in a repository would still return or change another tenant's rows; nothing in the database stops it. ADR-0038 left that as residual risk (its §5 item 1) and named row-level security (RLS) as the follow-up.

The 2026-10-15 and 2026-10-19 research (owner's local R06 results and `R06-phase2-architecture.md`) verified, against Drizzle 0.45, pg 8.23 and Better Auth 1.7.7/1.7.10:

- A tenant context only isolates if it's **transaction-local** (`set_config(…, true)`): a session-level value survives on a reused connection, a transaction-local one is gone at `COMMIT` or `ROLLBACK`.
- Drizzle's top-level `transaction()` always sends `BEGIN`/`COMMIT`. Opened while the same client is already in a transaction (for example inside Better Auth's adapter transaction, `transaction: true` since #155), its `COMMIT` **commits the outer transaction early**: a later failure of the outer one no longer rolls back what ran before (probe: outer insert, inner insert and a later outer insert all survived the outer failure).
- A savepoint nests correctly for rollback, but a transaction-local `set_config` inside it **stays set for the rest of the outer transaction** after `RELEASE`.
- pg's `client.getTransactionStatus()` reports `I`/`T`/`E` from the last ReadyForQuery, with no round trip.
- None of our Better Auth hooks runs inside a Better Auth transaction today (`membershipLimit`, `afterAcceptInvitation`, `beforeDeleteOrganization`, the role-update hooks and our `hooks.before` all run outside it), but nothing enforced that across upgrades.
- Only `project` and `billing_subscription` hold tenant data outside Better Auth; 8 repository functions reach them. `getTenantContext` reads only `organization` and `member`.
- FK cascades bypass RLS; the runtime role can set any `app.*` setting itself; production still runs as `app_owner`, which bypasses RLS, until ADR-0038's G3/G4 switch.

## Decision

Owner decisions of 2026-10-19 (R06 Phase 2 §7):

1. **Tenant context per repository call, transaction-local, refusing to join another transaction.** One helper in `packages/db/src/tenant-transaction.ts`, reachable from outside the package only through `@saas-foundation/db/internal` (tests):
   - `inTenant(db, scope, fn)`: refuses an empty `scope.orgId`; otherwise opens its own transaction, runs `set_config('app.org_id', orgId, true)`, then `fn(tx)`. Every statement on a tenant table runs on that `tx`.
   - `ownTransaction(db, fn)`: the guard. If the client's transaction status isn't `I` (idle), it throws `TenantTransactionError` before sending anything. This fails closed when transaction ownership can't be guaranteed: a tenant call inside Better Auth's transaction, inside another tenant call, or on a client in an unknown state. It makes nesting impossible by construction, so neither the early commit nor the savepoint leak can happen.
   - `enterTenant(tx, orgId)`: sets the context on a transaction the caller already owns, for the webhook (decision 4).
   - **Only this file calls `set_config`.** ESLint refuses the string `set_config` (any case, string or template literal) everywhere else in the repository; `scripts/lint-boundaries.test.mjs` proves it.
2. **Scope: `project` and `billing_subscription` only.** Their 8 repository functions (`projects().list/get/count/createWithinLimit/update/remove`, `billing().subscription`, `applyBillingEvent`) run through the helper. Better Auth tables (`organization`, `member`, `invitation`, `user`, `session`, `account`, `verification`) stay filter-only: Better Auth reads them across tenants by design, and `countMembers`, `listOwners`, `findMembership` keep their explicit filters.
3. **Transaction boundary.** The tenant transaction is the repository call, not the request. A server function that calls several repositories gets several short transactions (partial writes across calls are possible, as before). An operation that needs both protected tables atomically must be one `packages/db` function with one `inTenant`. `createWithinLimit` and `applyBillingEvent` were already transactions; the helper replaces their `transaction()`.
4. **The webhook bypass stays narrow.** `applyBillingEvent` opens its transaction with `ownTransaction` (the dedupe insert precedes knowing the organization), locks the organization named by the verified subscription, then calls `enterTenant` with that organization's id. Every later statement runs in that tenant, except the one cross-tenant read: "is this subscription held by another organization?". Phase 2 moves that read into an owner-owned `SECURITY DEFINER` function with a pinned `search_path` that returns only a boolean, `EXECUTE` granted to `app_runtime` alone. No other bypass exists; a new one needs a change to this ADR.
5. **Policies (phase 3) are declared in the Drizzle schema with `pgPolicy`** (R05), `TO app_runtime`, `USING` and `WITH CHECK` `organization_id = NULLIF(current_setting('app.org_id', true), '')`, so a missing context reads nothing and writes nothing (fail closed, 42501). **#151 (migration/schema integrity gate) merges before phase 3.** The phase 3 PR verifies the generated migration (`ENABLE ROW LEVEL SECURITY`, the policies' expressions, no `push` drift) and what enabling RLS does to every existing role: the owner and migrations keep full access, `app_runtime` gets only policy-allowed rows, archive triggers (ADR-0039) and FK cascades still work.
6. **No `FORCE ROW LEVEL SECURITY`.** The owner (`app_owner`) runs migrations, backups (ADR-0023), restores and archive queries (ADR-0039) and must not be filtered. Instead a catalog test asserts that the enforcement role (`app_runtime`) owns no protected table and has neither `BYPASSRLS` nor superuser, and that every non-auth table with `organization_id` has RLS enabled and a runtime policy.
7. **Enforcement starts at ADR-0038's G3/G4 runtime-role switch**, after the preview Hyperdrive checks (below). Phases 1–3 can ship while production is on `app_owner`; policies have no effect there until the switch.
8. **Round trips accepted provisionally.** Each wrapped call costs +3 round trips (`BEGIN`, `set_config`, `COMMIT`; +1 for the two calls that were already transactions). Accepted for development. **Before G3/G4 enforcement**, preview latency through Hyperdrive is measured on the critical paths (R04: project navigation +3, create +4, create-and-refresh +7) and recorded here; a material cost reopens per-request contexts (R06 brief design B) or batching.

### Threat model

| In scope (RLS contains it)                                                                                     | Out of scope (stated, covered elsewhere or not at all)                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A repository function on `project` or `billing_subscription` that omits or breaks its `organization_id` filter | Arbitrary SQL as `app_runtime` (leaked credential, code execution): it can set `app.org_id` itself. ADR-0038 grants and ADR-0039 archive/audit apply       |
| A write that targets another tenant's id (`WITH CHECK`)                                                        | FK cascades from `organization` (they bypass RLS; deletion is authorized by Better Auth and archived by ADR-0039)                                          |
| A tenant call made without context (fails closed)                                                              | Better Auth tables (no policies; explicit filters and Better Auth's own checks)                                                                            |
| A tenant context leaking to a later request on a reused connection (transaction-local only)                    | Hyperdrive query caching: disabled on the only binding (invariant 7). If ever enabled, a cached tenant read could cross tenants; it needs a new ADR anyway |

### Staged rollout

| Phase | Content                                                                                                                                                | Releases                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1     | Helper, guard, 8 functions moved, lint rule, regression tests. No policies, no migration. Behaviour unchanged apart from the guard                     | Its own release, live **before** phase 3 (ADR-0029 migrates before the new version is promoted) |
| 2     | Definer conflict lookup (custom migration, `REVOKE … FROM PUBLIC`, `GRANT EXECUTE` to `app_runtime`, catalog test); `applyBillingEvent` switched to it | May ship with phase 1                                                                           |
| 3     | `pgPolicy` policies + `ENABLE ROW LEVEL SECURITY` after #151; catalog, fail-closed and omitted-filter tests                                            | After phase 1 is live; no production effect until phase 4                                       |
| 4     | Production enforcement at the G3/G4 switch, after the preview checks                                                                                   | Owner approval (ADR-0038 runbook)                                                               |
| 5     | AGENTS.md recipe (`pgPolicy` for a new tenant table), Code Review Rules, runbook (an empty list or 42501 means a missing context)                      | With phase 3                                                                                    |

Preview checks before phase 4 (need Actions and an approved preview; ADR-0021): through a real Worker → Hyperdrive → Neon, (a) transaction-local `set_config` is visible inside and gone after `COMMIT`, (b) a failed tenant call rolls back, (c) `getTransactionStatus()` reads `I` after `COMMIT` and `T` inside, so the guard neither blocks every call nor misses a nested one, (d) the latency of decision 8, (e) with the binding's query caching disabled, two tenants' identical tenant-scoped reads in alternation each return only their own rows (no cached result crosses tenants), and the binding's configuration shows caching off.

## Consequences

- A future Better Auth version that calls our hooks inside its transaction fails loudly (`TenantTransactionError`) instead of silently breaking #155's atomicity. Such a hook then needs a reviewed redesign (for example a definer read), not a bypass of the guard.
- A repository can't call another tenant repository from inside its transaction; such work is one function.
- Tenant repositories cost more round trips (decision 8) until measured.
- New tenant tables follow the same pattern: their repository runs through `inTenant`, and phase 3's catalog test fails without a policy.

## Alternatives

- **Per-request context (design B):** fewer round trips, but Better Auth's handler runs outside any tenant request, so its hook reads would need design A anyway; longer locks and transactions spanning external calls; every server function changes. Revisit only if decision 8's measurement makes per-call cost material.
- **Join an open transaction with a savepoint:** leaks the context into the caller's transaction after `RELEASE`.
- **Check the transaction state with SQL** (`now() <> statement_timestamp()`): a round trip per call, for what pg already reports.
- **`FORCE ROW LEVEL SECURITY`:** would filter the owner's backups, restores and archive queries.
- **Amend ADR-0038:** ADR-0038 is about privileges; tenant context, transaction boundaries and policies are a separate decision with their own rollout.

## Notes

Regression tests (`apps/app/test/tenant-transaction.test.ts`): a tenant read inside another transaction on the client is refused and that transaction still rolls back everything (the Better Auth adapter shape); a tenant call inside a tenant call is refused; a missing tenant is refused before anything runs; a failure inside a tenant call writes nothing and leaves the client idle with no context; tenant A then B on one client see only their own context, with none between; 100 alternating-tenant requests each see only their own context and projects; a project of one tenant can't be read, updated or deleted through another. The Better Auth hook paths that read billing state (seat limits on invitation and acceptance, deletion refused with a live subscription, organization deletion) run end to end in `billing.test.ts`, `tenancy.test.ts` and `organization-delete.test.ts` with the guard in place.
