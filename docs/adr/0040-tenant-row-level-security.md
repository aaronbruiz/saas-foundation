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

1. **Tenant context per repository call, transaction-local, in a transaction that owns the request's connection.** Two files in `packages/db`. The helpers are reachable from outside the package only through `@saas-foundation/db/internal` (tests):
   - **`connection.ts`, `GuardedClient`:** the pg `Client` subclass that `createDb` creates (the only client the app makes). It enforces ownership on every statement: our repositories, Better Auth's adapter (`drizzleAdapter(rawDb(db))`), raw Drizzle and `$client.query` all reach pg through its `query` override (Drizzle's `transaction()` sends `begin`/`commit`/`rollback` there too; checked in Drizzle 0.45.4 `node-postgres/session.js`). A tenant transaction is `runOwned(fn)`:
     - **Claim:** taken synchronously, before anything is awaited, and refused (`TenantTransactionError`, nothing sent) unless the connection is idle, with nothing pending. That means status `I`, `readyForQuery` true (closing the gap between an ErrorResponse and its ReadyForQuery), an empty queue, no active query and no pipeline mode. It is also refused from inside any tenant transaction's async context, so nothing nests.
     - **Ownership while it runs:** the claim is an owner token held in an `AsyncLocalStorage` context. A statement from any other async context is refused in `query` before pg queues it. This covers another request handler, a Better Auth transaction's `BEGIN` or `COMMIT`, raw Drizzle and a stale callback.
     - **Inside the owner:** only single plain statements run. The token's own `BEGIN`, `COMMIT`, `ROLLBACK` and its one `set_config` go through a private path. Anything that could end, nest or reconfigure the transaction is refused: `BEGIN`/`START`, `COMMIT`/`END`, `ROLLBACK`/`ABORT`, savepoints, `PREPARE`, `SET`/`RESET`/`DISCARD`, `DO`/`CALL`, `LOCK`, `COPY`, `LISTEN`/`NOTIFY`, and any text containing `;` or `set_config`. Leading comments are ignored when matching. This also refuses a nested Drizzle `transaction()`.
     - **Release:** after `COMMIT`, or after `ROLLBACK` on any failure, in `finally`, on every path. The token is then marked dead, so callbacks left behind by the transaction are refused for good. A transaction that didn't end cleanly (status not `I` afterwards, for example a lost connection or a failed `ROLLBACK`) marks the connection broken, and it refuses everything from then on.
     - **Outside any owner:** every statement except the setter is refused if its text contains `set_config`, or `SET`/`RESET` together with an `app.` setting. Nothing can leave a session-level tenant context behind.
   - **`tenant-transaction.ts`:**
     - `inTenant(db, scope, fn)` refuses an empty `scope.orgId`, then runs `fn(tx)` as owner with the tenant set (`set_config('app.org_id', orgId, true)`, once per transaction). Every statement on a tenant table runs there.
     - `ownTransaction(db, fn)` is the same without the tenant, for the webhook.
     - `enterTenant(tx, orgId)` sets the tenant once on the running owner's transaction (decision 4).
   - **Guarantee:** while a tenant transaction runs, no statement from outside it reaches its connection, and nothing inside it can commit, roll back, nest or change its tenant early. This holds by construction for every caller that holds the `Db`, and isn't left to callers avoiding concurrency.
   - **Assumptions it rests on** (each protected by a test, and revalidated on every pg, Drizzle or Better Auth upgrade):
     - (a) every app connection is a `GuardedClient`. `createDb` is the only factory, and lint keeps `pg` imports in `packages/db`.
     - (b) code outside `packages/db` and tests can't reach the client. Lint refuses `$client` (member, computed or destructured) and `rawDb` outside `packages/db`, `packages/auth`'s adapter and tests.
     - (c) pg 8 state read by the claim: `readyForQuery`, `pipeline`, `_queryQueue`, `_getActiveQuery`, `getTransactionStatus()`. These are undocumented internals except the last, checked against pg 8.23.1. A missing field refuses every tenant call, and the test suite shows it at once. A change of meaning would not show, so **every pg upgrade revalidates them against the installed source**.
     - (d) Workers' `AsyncLocalStorage` (`nodejs_compat`) propagates through `await`, verified in workerd by the tests.
   - **Not covered** (deliberate circumvention, not mistakes):
     - code inside `packages/db` that calls pg's `Client.prototype.query` or `client.connection` directly;
     - `client.end()` from outside. It closes the connection; the server then rolls back the open transaction, so nothing is committed early.
   - **Lint keeps SQL checkable** (`scripts/lint-boundaries.test.mjs` proves each rule):
     - only `connection.ts` contains `set_config` or `SET`/`RESET app.*`. This holds in any case, for string literals and for template literals by raw and cooked text, so escapes don't hide it.
     - string literals can't be split (`'set_' + 'config'`, `${'set_'}config`).
     - `sql.raw` is refused in every form.
     - in application and package source, `execute`/`query` take only the `sql` tag or a string literal, never text built at runtime.
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

### Acceptance criteria for the enforcement gate (phase 4)

Production enforcement (G3/G4 with policies in place) starts only when all of these hold, each recorded in this ADR's Notes with its evidence:

1. **Transaction ownership:** the earlier race (non-tenant work on a client while a tenant transaction is starting or running) is eliminated or made impossible by an enforced invariant. **Met in phase 1** by `GuardedClient` (decision 1), with the assumptions (a)–(d) listed there; re-check them, and run its regression tests, on the production versions before enforcement.
2. **Hyperdrive behaviour validated on a preview:** transaction-local context, rollback, the guard's status reads, latency (decision 8) and query caching, items (a)–(e) below.
3. **#151 merged** before the policy phase (phase 3), and the generated policy migration reviewed as decision 5 describes.
4. **G3/G4 verified:** the runtime role's effective privileges (ADR-0038 runbook) and effective RLS behaviour as that role through Hyperdrive: no rows and refused writes without context, only the tenant's rows with it, and the catalog test (decision 6) passing against the production database.

Preview checks before phase 4 (need Actions and an approved preview; ADR-0021): through a real Worker → Hyperdrive → Neon, (a) transaction-local `set_config` is visible inside and gone after `COMMIT`, (b) a failed tenant call rolls back, (c) `getTransactionStatus()` reads `I` after `COMMIT` and `T` inside, so the guard neither blocks every call nor misses a nested one, (d) the latency of decision 8, (e) with the binding's query caching disabled, two tenants' identical tenant-scoped reads in alternation each return only their own rows (no cached result crosses tenants), and the binding's configuration shows caching off.

## Consequences

- A future Better Auth version that calls our hooks inside its transaction, or runs its own work on the connection while a tenant transaction owns it, fails loudly (`TenantTransactionError`) instead of silently breaking #155's atomicity. Such a hook then needs a reviewed redesign (for example a definer read), not a bypass of the guard.
- A repository can't call another tenant repository from inside its transaction; concurrent work on the same `Db` while one runs is refused. Such work is one function, or runs after it.
- Every statement on the app's connection pays a synchronous check (an `AsyncLocalStorage` read and, for the owner, a regular-expression match): no round trip.
- Tenant repositories cost more round trips (decision 8) until measured.
- New tenant tables follow the same pattern: their repository runs through `inTenant`, and phase 3's catalog test fails without a policy.

## Alternatives

- **Per-request context (design B):** fewer round trips, but Better Auth's handler runs outside any tenant request, so its hook reads would need design A anyway; longer locks and transactions spanning external calls; every server function changes. Revisit only if decision 8's measurement makes per-call cost material.
- **Join an open transaction with a savepoint:** leaks the context into the caller's transaction after `RELEASE`.
- **Check the transaction state with SQL** (`now() <> statement_timestamp()`): a round trip per call, for what pg already reports.
- **`FORCE ROW LEVEL SECURITY`:** would filter the owner's backups, restores and archive queries.
- **Amend ADR-0038:** ADR-0038 is about privileges; tenant context, transaction boundaries and policies are a separate decision with their own rollout.

## Notes

Regression tests (`apps/app/test/tenant-transaction.test.ts`, deterministic: competing work starts at a barrier while the tenant transaction holds the connection mid-transaction, or in pg's error callback):

- **Before the claim:** a tenant read inside another transaction on the client is refused, and that transaction still rolls back everything (the Better Auth adapter shape). A tenant call inside a tenant call is refused. Of two tenant calls started together, one runs and the other is refused. A tenant call is refused while a raw `BEGIN` is queued or a raw transaction is open, and works once it ends. A tenant call between an ErrorResponse and ReadyForQuery is refused (fails without the `readyForQuery` check).
- **During ownership:** a raw Drizzle transaction started during a tenant transaction is refused before `BEGIN` is sent, and the tenant transaction still rolls back, or commits exactly its own work. Raw `COMMIT`, `ROLLBACK` and plain statements from outside are refused. A Better Auth sign-up on the same connection fails without touching it (no user created). A raw transaction and a tenant call started together: exactly one runs and the connection recovers.
- **Inside ownership:** statements that would end, nest or re-tenant the transaction are refused (17 forms plus nested Drizzle transactions), and the tenant stays set.
- **After it ends:** a callback left behind by a finished tenant transaction can't use the connection. A connection lost mid-transaction commits nothing and refuses further tenant calls.
- **Context and isolation:** a missing tenant is refused before anything runs. A failure writes nothing and leaves the client idle with no context. Tenant A then B on one client see only their own context, with none between. 100 alternating-tenant requests each see only their own. A project of one tenant can't be read, updated or deleted through another.

The Better Auth hook paths that read billing state (seat limits on invitation and acceptance, deletion refused with a live subscription, organization deletion) run end to end in `billing.test.ts`, `tenancy.test.ts` and `organization-delete.test.ts` with the guard in place.
