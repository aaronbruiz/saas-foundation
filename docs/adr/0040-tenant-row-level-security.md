# ADR-0040: Tenant context per repository call and row-level security on tenant tables

Status: Partially accepted (owner 2026-10-21) · Date: 2026-10-19

Decisions 1–4 (phases 1–2: tenant transactions, `GuardedClient`, the webhook definer) are accepted, implemented and binding. Implemented means merged on `main`; they reach production with the next release (roadmap M1). Decisions 7–8 (the role switch before enforcement, the round-trip measurement before the switch) were revised for roadmap M2 and accepted by the owner on 2026-10-21: production switches to `app_runtime` (ADR-0038 G3/G4) before any policy exists. Decisions 5–6 (policies, no `FORCE`) and the phase 3 release they describe remain proposed and are not approved implementation requirements: M4 decides whether RLS enforcement is adopted.

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

1. **Tenant context per repository call, transaction-local, in a transaction that owns the request's connection.**
   - **Mechanism:**
     - `packages/db/src/connection.ts`: `GuardedClient`, the pg `Client` subclass that `createDb` makes (the only client the app makes). Its `query` override is the one path for every statement: our repositories, Better Auth's adapter (`drizzleAdapter(rawDb(db))`), raw Drizzle (its `transaction()` sends `begin`/`commit`/`rollback` there too; checked in Drizzle 0.45.4 `node-postgres/session.js`) and `$client.query`. A tenant transaction is `runOwned(fn)`; its `BEGIN`, `COMMIT`, `ROLLBACK` and its single `set_config('app.org_id', orgId, true)` go through a private path.
     - `packages/db/src/tenant-transaction.ts`, reachable from outside the package only through `@saas-foundation/db/internal` (tests):
       - `inTenant(db, scope, fn)` refuses an empty `scope.orgId`, then runs `fn(tx)` as owner with the tenant set (once per transaction). Every statement on a tenant table runs there.
       - `ownTransaction(db, fn)` does the same without the tenant, for the webhook.
       - `enterTenant(tx, orgId)` sets the tenant once on the running owner's transaction (decision 4).
   - **Guaranteed** (by construction for every caller holding the `Db`, under assumptions (a)–(d) below; each has a deterministic test against real PostgreSQL in workerd):
     - _Connection ownership._ The claim is taken synchronously, before anything is awaited. It is refused (`TenantTransactionError`, nothing sent) unless all of these hold:
       - the connection is idle: status `I` and `readyForQuery` (closing the gap between an ErrorResponse and its ReadyForQuery), with an empty queue, no active query and no pipeline mode;
       - it isn't broken;
       - the caller isn't inside any tenant transaction's async context. This makes nesting impossible.
     - _Cross-context rejection._ While a tenant transaction owns the connection, any statement from another async context (`AsyncLocalStorage` owner token) is refused in `query` before pg queues it. That includes another caller, a Better Auth or raw Drizzle `BEGIN`/`COMMIT`/`ROLLBACK`, and a plain query.
     - _Transaction lifecycle._ The owner's admission closes synchronously the moment `fn` settles, before `COMMIT` or `ROLLBACK` is queued, so nothing it started can be queued behind them.
       - If statements it admitted are still pending at that moment, or the transaction is no longer open (status not `T`), the transaction rolls back and the call fails (`TenantTransactionError`). This fails closed, and pending statements run inside the rolled-back transaction.
       - A `COMMIT` that doesn't report `COMMIT` fails the call.
       - Ownership is released only after the transaction has ended, on every path (success, error, failed `ROLLBACK`, lost connection). The token stays dead, so callbacks left behind are refused for good, and a connection that isn't idle afterwards refuses everything from then on.
       - JavaScript can't cancel a promise. A request cancelled by the runtime closes its connection, and PostgreSQL rolls back the open transaction.
   - **Defense in depth** (best effort, **not** complete protection; text inspection can't parse PostgreSQL):
     - _Statement restrictions in `GuardedClient`._
       - Inside an owner, only a single plain statement of the kind Drizzle generates runs. It must start with `select`, `insert`, `update`, `delete` or `with`, and contain no comment, `;`, `U&` identifier, dollar quoting, `set_config` or `pg_settings`.
       - Outside an owner, text that visibly sets the tenant context (`set_config`, or `SET`/`RESET` with an `app.` setting) is refused.
       - These checks catch mistakes and the demonstrated spellings (nested comments, Unicode escapes, `pg_settings`). They don't prove that a statement can't end the transaction or change a setting.
     - _A session-level tenant setting left on the connection by other code can't reach a tenant transaction_: its own transaction-local setting overrides it (tested). It doesn't prevent such a setting from applying outside tenant transactions, where no protected table is read.
     - _Lint_ (`scripts/lint-boundaries.test.mjs` proves each rule):
       - only `connection.ts` contains `set_config` or `SET`/`RESET app.*`. This holds in any case, for string literals and for template literals by raw and cooked text.
       - string literals can't be split.
       - no `sql.raw` in any form, and `sql` is never aliased, renamed, namespace-imported or reassigned.
       - in application and package source, `execute`/`query` take only the `sql` tag or a string literal, never text built at runtime or another tag (`String.raw`).
       - `$client` (member, computed or destructured) and `pg` imports stay in `packages/db` and tests.
   - **Out of scope:** arbitrary or malicious SQL run by trusted application code with the database role. SQL written in `packages/db` with intent can still end the transaction, change the tenant or bypass the guard, for example through pg's `Client.prototype.query` or `client.connection`, a function with side effects, or a spelling the checks miss. This is the same exposure as "arbitrary SQL as `app_runtime`" in the threat model; ADR-0038 grants, ADR-0039 archive/audit and review cover it. `client.end()` from outside closes the connection, and the server then rolls back.
   - **Assumptions** (revalidated on every pg, Drizzle or Better Auth upgrade):
     - (a) every app connection is a `GuardedClient`: `createDb` is the only factory, and lint keeps `pg` imports in `packages/db`.
     - (b) code outside `packages/db` and tests can't reach the client: lint refuses `$client` there, and `rawDb` stays in `packages/db`, `packages/auth`'s adapter and tests.
     - (c) pg 8 state: `readyForQuery`, `pipeline`, `_queryQueue`, `_getActiveQuery` (undocumented internals) and `getTransactionStatus()`, checked against pg 8.23.1. A missing field refuses every tenant call, and the test suite shows it at once. A change of meaning would not show, so **every pg upgrade revalidates them against the installed source**.
     - (d) Workers' `AsyncLocalStorage` (`nodejs_compat`) propagates through `await` and timers. This is verified in workerd by the tests.
2. **Scope: `project` and `billing_subscription` only.** Their 8 repository functions (`projects().list/get/count/createWithinLimit/update/remove`, `billing().subscription`, `applyBillingEvent`) run through the helper. Better Auth tables (`organization`, `member`, `invitation`, `user`, `session`, `account`, `verification`) stay filter-only: Better Auth reads them across tenants by design, and `countMembers`, `listOwners`, `findMembership` keep their explicit filters.
3. **Transaction boundary.** The tenant transaction is the repository call, not the request. A server function that calls several repositories gets several short transactions (partial writes across calls are possible, as before). An operation that needs both protected tables atomically must be one `packages/db` function with one `inTenant`. `createWithinLimit` and `applyBillingEvent` were already transactions; the helper replaces their `transaction()`.
4. **The webhook bypass stays narrow.** `applyBillingEvent` opens its transaction with `ownTransaction` (the dedupe insert precedes knowing the organization), locks the organization named by the verified subscription, then calls `enterTenant` with that organization's id. Every later statement runs in that tenant, except the one cross-tenant read: "is this subscription held by another organization?". Since phase 2 (migration `0008_billing_conflict_definer.sql`) that read is `public.billing_subscription_held_elsewhere(provider, subscription_id) → boolean`, called with a plain `select` inside the webhook's owned transaction, right after `enterTenant`. No other bypass exists; a new one needs a change to this ADR.
   - **Shape:** `plpgsql`, `STABLE`, `SECURITY DEFINER`, owned by the migration owner (the tables' owner, so it reads past RLS: no `FORCE`, decision 6), `SET search_path = pg_catalog, pg_temp`, every object schema-qualified, no dynamic SQL. It lives in `public`, where `app_runtime` has `USAGE` but not `CREATE`. `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO app_runtime` only.
   - **The tenant comes from the transaction, not an argument:** it compares against `current_setting('app.org_id', true)`, so a caller can't name an arbitrary organization. A missing, empty or unknown organization id, or a null argument, raises 42501 (fail closed: the webhook errors and the provider retries; it never answers "not held").
   - **Answers only yes or no:** never the holder, its status or any other column.
   - **Concurrency unchanged:** the organization lock still serializes one organization's events. Two organizations racing for the same new subscription id are settled by the `(provider, provider_subscription_id)` unique constraint: the loser fails (nothing recorded), and its retry answers `conflict`.
   - **Limitation: `app.org_id` selects, it doesn't authenticate.** A role that can run arbitrary SQL as `app_runtime` (and set a custom setting: `set_config`, `SET`, or a startup `options` parameter that no statement guard sees) can claim any organization's id and learn whether a subscription id it already knows is held by some other organization. That is a one-bit oracle, keyed by an id Polar generates, and the same principal can already read the table until policies are enforced (phase 3 released while production runs as `app_runtime`). The function also can't tell a transaction-local setting from a session-level one, and it doesn't take or check the organization lock: the webhook's guarantees come from `applyBillingEvent` running it inside its guarded transaction (decision 1), not from the function.
5. **Policies (phase 3) are declared in the Drizzle schema with `pgPolicy`** (R05), `TO app_runtime`, `USING` and `WITH CHECK` `organization_id = NULLIF(current_setting('app.org_id', true), '')`, so a missing context reads nothing and writes nothing (fail closed, 42501). **#151 (migration/schema integrity gate) merges before phase 3.** The phase 3 PR verifies the generated migration (`ENABLE ROW LEVEL SECURITY`, the policies' expressions, no `push` drift) and what enabling RLS does to every existing role: the owner and migrations keep full access, `app_runtime` gets only policy-allowed rows, archive triggers (ADR-0039) and FK cascades still work.
6. **No `FORCE ROW LEVEL SECURITY`.** The owner (`app_owner`) runs migrations, backups (ADR-0023), restores and archive queries (ADR-0039) and must not be filtered. Instead a catalog test asserts that the enforcement role (`app_runtime`) owns no protected table and has neither `BYPASSRLS` nor superuser, and that every non-auth table with `organization_id` has RLS enabled and a runtime policy.
7. **The runtime-role switch comes first; enforcement starts with the policies.** ADR-0038's G3/G4 switch (roadmap M2) doesn't depend on RLS: least privilege stands on its own, and phases 1–2 work the same as `app_owner` or `app_runtime`. `app_owner` bypasses RLS (it owns the tables, no `FORCE`, decision 6) and `app_runtime` is subject to it, so with production already on `app_runtime`, releasing phase 3 is what starts enforcement. That release needs the acceptance criteria below and the owner's decision to adopt RLS (roadmap M4). If phase 3 were ever released while production still runs as `app_owner`, the policies would have no effect there until the switch.
8. **Round trips accepted provisionally.** Each wrapped call costs +3 round trips (`BEGIN`, `set_config`, `COMMIT`; +1 for the two calls that were already transactions). They apply as soon as phase 1 is live, whatever the role. Accepted for development. **Before the G3/G4 switch** (roadmap M2), preview latency through Hyperdrive is measured on the critical paths (R04: project navigation +3, create +4, create-and-refresh +7) and recorded here; a material cost reopens per-request contexts (R06 brief design B) or batching.

### Threat model

| In scope (RLS contains it)                                                                                     | Out of scope (stated, covered elsewhere or not at all)                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A repository function on `project` or `billing_subscription` that omits or breaks its `organization_id` filter | Arbitrary SQL as `app_runtime` (leaked credential, code execution): it can set `app.org_id` itself. ADR-0038 grants and ADR-0039 archive/audit apply       |
| A write that targets another tenant's id (`WITH CHECK`)                                                        | FK cascades from `organization` (they bypass RLS; deletion is authorized by Better Auth and archived by ADR-0039)                                          |
| A tenant call made without context (fails closed)                                                              | Better Auth tables (no policies; explicit filters and Better Auth's own checks)                                                                            |
| A tenant context leaking to a later request on a reused connection (transaction-local only)                    | Hyperdrive query caching: disabled on the only binding (invariant 7). If ever enabled, a cached tenant read could cross tenants; it needs a new ADR anyway |

### Staged rollout

| Phase | Content                                                                                                                                                       | Releases                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Helper, guard, 8 functions moved, lint rule, regression tests. No policies, no migration. Behaviour unchanged apart from the guard                            | Its own release, live **before** phase 3 (ADR-0029 migrates before the new version is promoted)                                                                                                                   |
| 2     | Definer conflict lookup (custom migration `0008`, `REVOKE … FROM PUBLIC`, `GRANT EXECUTE` to `app_runtime`, catalog test); `applyBillingEvent` switched to it | May ship with phase 1. Its migration must run before its code is promoted (ADR-0029 does: migrate, then the 0% candidate). The previous version never calls the function, so a rollback of the code keeps working |
| 3     | `pgPolicy` policies + `ENABLE ROW LEVEL SECURITY` after #151; catalog, fail-closed and omitted-filter tests                                                   | After phase 1 is live and the owner adopts RLS (roadmap M4). Enforces in production once released, since production runs as `app_runtime` after phase 4; needs the acceptance criteria below                      |
| 4     | Production switches to `app_runtime` (ADR-0038 G3/G4, roadmap M2), after preview check (d). Independent of phase 3: no policy needed                          | Owner approval (ADR-0038 runbook). Normally before phase 3                                                                                                                                                        |
| 5     | AGENTS.md recipe (`pgPolicy` for a new tenant table), Code Review Rules, runbook (an empty list or 42501 means a missing context)                             | With phase 3                                                                                                                                                                                                      |

### Acceptance criteria for the enforcement gate (phase 3 release)

Production enforcement (phase 3's policies released while production runs as `app_runtime`) starts only when all of these hold, each recorded in this ADR's Notes with its evidence:

1. **Transaction ownership:** the earlier race (non-tenant work on a client while a tenant transaction is starting or running) is eliminated or made impossible by an enforced invariant. **Met in phase 1** by `GuardedClient`'s guarantees (decision 1, "Guaranteed") under assumptions (a)–(d). Re-check the assumptions and run its regression tests on the production versions before enforcement. The SQL text checks are defense in depth and don't count toward this criterion.
2. **Hyperdrive behaviour validated on a preview:** transaction-local context, rollback, the guard's status reads, latency (decision 8) and query caching, items (a)–(e) below.
3. **#151 merged** before the policy phase (phase 3), and the generated policy migration reviewed as decision 5 describes.
4. **G3/G4 verified and RLS behaviour checked:** the runtime-role switch done (phase 4: ADR-0038 runbook, effective privileges), then effective RLS behaviour as that role through Hyperdrive on a preview: no rows and refused writes without context, only the tenant's rows with it.

Right after the release (mandatory, not a precondition): the same behaviour checked in production as `app_runtime`, and the catalog test (decision 6) passing against the production database, both recorded in Notes.

Preview checks (need Actions and an approved preview; ADR-0021). (a)–(c) and (e) are roadmap M1's Hyperdrive validation; (d) is required before the phase 4 switch (roadmap M2). Through a real Worker → Hyperdrive → Neon, (a) transaction-local `set_config` is visible inside and gone after `COMMIT`, (b) a failed tenant call rolls back, (c) `getTransactionStatus()` reads `I` after `COMMIT` and `T` inside, so the guard neither blocks every call nor misses a nested one, (d) the latency of decision 8, (e) with the binding's query caching disabled, two tenants' identical tenant-scoped reads in alternation each return only their own rows (no cached result crosses tenants), and the binding's configuration shows caching off.

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

Regression tests (`apps/app/test/tenant-transaction.test.ts`, deterministic: competing work starts at a barrier while the tenant transaction holds the connection mid-transaction, in pg's error callback, or after polling microtasks until `COMMIT`/`ROLLBACK` is on the wire, which no server response can interrupt; the finalization tests fail with the admission closure removed):

- **Before the claim:** a tenant read inside another transaction on the client is refused, and that transaction still rolls back everything (the Better Auth adapter shape). A tenant call inside a tenant call is refused. Of two tenant calls started together, one runs and the other is refused. A tenant call is refused while a raw `BEGIN` is queued or a raw transaction is open, and works once it ends. A tenant call between an ErrorResponse and ReadyForQuery is refused (fails without the `readyForQuery` check).
- **During ownership:** a raw Drizzle transaction started during a tenant transaction is refused before `BEGIN` is sent, and the tenant transaction still rolls back, or commits exactly its own work. Raw `COMMIT`, `ROLLBACK` and plain statements from outside are refused. A Better Auth sign-up on the same connection fails without touching it (no user created). A raw transaction and a tenant call started together: exactly one runs and the connection recovers.
- **Inside ownership** (defense in depth): statements that would end, nest or re-tenant the transaction are refused (17 forms plus nested Drizzle transactions), and so are a `COMMIT` hidden in nested comments, a Unicode-escaped `set_config` and an `UPDATE pg_settings`. The tenant stays set, and the transaction still rolls back.
- **Lifecycle:** work resumed inside the body after it returned or threw is refused, and never runs after `COMMIT` or `ROLLBACK`. Work admitted just before the body settles, or still running when it does, fails the transaction closed, and nothing commits. A callback left behind by a finished tenant transaction can't use the connection. A connection lost mid-transaction commits nothing and refuses further tenant calls. A session-level tenant setting left by other code never reaches a tenant transaction.
- **Context and isolation:** a missing tenant is refused before anything runs. A failure writes nothing and leaves the client idle with no context. Tenant A then B on one client see only their own context, with none between. 100 alternating-tenant requests each see only their own. A project of one tenant can't be read, updated or deleted through another.

The Better Auth hook paths that read billing state (seat limits on invitation and acceptance, deletion refused with a live subscription, organization deletion) run end to end in `billing.test.ts`, `tenancy.test.ts` and `organization-delete.test.ts` with the guard in place.

Phase 2 tests (`billing.test.ts` "the subscription holder check", `database-role.test.ts`), against real PostgreSQL as `app_runtime` and, for the RLS case, the owner:

- The webhook suite runs unchanged through the function, including "never moves a subscription to another organization" (`conflict`). The function answers only `{ held: boolean }`: true for another organization's subscription, false for the tenant's own, an unknown id or another provider.
- Fails closed (42501) with no tenant, an empty or malformed session-level one, an unknown organization or a null argument; a refusal rolls back the whole tenant transaction (an earlier insert isn't recorded).
- Temporary tables named `billing_subscription`/`organization`, a `pg_temp.current_setting` and the caller's `search_path = pg_temp, public` don't change its answers.
- Two organizations applying the same new subscription at once: exactly one holds it, the other ends at `conflict`.
- With phase 3's policy shape enabled in a rolled-back transaction and the role switched to `app_runtime`, a direct read of the other tenant's row returns nothing while the function still answers `true`.
- Catalog: `app_runtime` can execute exactly the functions in `FUNCTIONS` (this one), each `SECURITY DEFINER`, `STABLE`, `search_path=pg_catalog, pg_temp`, owned by the tables' owner, with `app_runtime:EXECUTE` (no grant option) the only non-owner grant. It can't replace, alter (`SECURITY INVOKER`, `search_path`, owner, name), drop or overload it, and its `GRANT … TO PUBLIC` changes nothing even inside its own transaction.
- Mutation check (local, 2026-10-19): an unpinned function with unqualified names, one without the context check, a `SECURITY INVOKER` one and a runtime grant `WITH GRANT OPTION` each fail these tests.

Preview checks (a)–(c) and (e), 2026-10-21 (roadmap M1 done-when 2), through a real Worker → Hyperdrive → Neon on a PR preview:

- **What ran:** release candidate app 0.4.0 (release PR #175, head `c09bbf1`) plus a throwaway probe (PR #178, closed unmerged): a function running the checks below through the real `createDb` → `GuardedClient` → `inTenant`, behind an operator-only route. The deployed build `aa99159` (CI's merge commit) differs from `c09bbf1` only by the reviewed probe files; connection code, dependencies, compatibility settings and the binding config are unchanged (diff checked). Preview config `saas-pr-178`, caching `disabled: true`; the Worker connected as the preview branch's owner.
- **(a)** `app.org_id` is the tenant inside a tenant call and empty after `COMMIT` and after a rolled-back call, on the same application client (for the committed call, the same backend pid inside and after; not recorded for the rolled-back one).
- **(b)** a tenant call that inserts a project and then throws leaves no row, and the client idle.
- **(c)** `getTransactionStatus()` is `T` inside, `I` after `COMMIT` and after `ROLLBACK`.
- **(e)** two tenants alternating 20 times on one client, and 100 tenant calls (6 at a time) each on its own client, all within one `/api/probe` request (separate Worker requests weren't exercised), all see only their own context and projects.
- **Released:** app 0.4.0 shipped as `c8d6a2a` (2026-10-29), which differs from `c09bbf1` only by CI's workflow and an ADR-0021 note (#180), neither part of the app build.
- **Not covered:** (d) latency (required before the phase 4 switch, roadmap M2); the runtime role (the preview ran as the owner); any RLS policy (phase 3).
- Runs: CI https://github.com/aaronbruiz/saas-foundation/actions/runs/39553677263, preview https://github.com/aaronbruiz/saas-foundation/actions/runs/39554137732, cleanup https://github.com/aaronbruiz/saas-foundation/actions/runs/39554569326 (`saas-pr-178` and `preview/pr-178` deleted afterwards).

Preview check (d), latency of decision 8, 2026-10-29 (roadmap M2), through a real Worker → Hyperdrive → Neon on a PR preview:

- **What ran:** `main` (8576a0b) plus a throwaway probe (PR #185, closed unmerged); the deployed build `0d12a54` (CI's merge commit) differs from `main` only by the reviewed probe files. Preview config `saas-pr-185`, caching `disabled: true` (read from the config); the Worker connected as the preview branch's owner. The preview ran at `cf-placement: remote-IAD`, as production does, against a Neon endpoint in `us-east-1`.
- **Method (owner-approved):** an unwrapped path can't run, since `GuardedClient` refuses `project` outside `inTenant`, so the baseline is an estimate. Each path runs the app's own repository calls: session and user read, organization, membership, then the list (navigation); the entitlements read and `createWithinLimit` (create); or the create followed by the two refresh loaders in parallel on their own clients (create-and-refresh). Right after each path sample, a matched sample on the same client runs one empty `inTenant` per newly wrapped call (+3) and one `select 1` per call that was already a transaction (+1). Added cost = the matched sample. Estimated baseline = path minus matched, per sample; percentiles are taken afterwards. Material (predeclared): p50 added > 50 ms on create-and-refresh or > 25 ms on navigation. The shortest single operation observed per run was 3–5 ms.
- **Results** (9 runs × 200 samples; ms; per-run p50 range and median of run p50s; pooled p95):

  | Path                    | Path p50            | Added p50        | Estimated baseline p50 | Path p95 | Added p95 |
  | ----------------------- | ------------------- | ---------------- | ---------------------- | -------- | --------- |
  | Navigation (+3)         | 41–72, median 54    | 15–25, median 19 | 34 (pooled)            | 91       | 34        |
  | Create (+4)             | 71–122, median 94   | 19–34, median 25 | 67 (pooled)            | 155      | 44        |
  | Create and refresh (+7) | 119–193, median 150 | 37–61, median 46 | 102 (pooled)           | 235      | 76        |

  One round trip (`select 1`) was 7 ms at p50 and an empty `inTenant` 19 ms, so the added cost is about 6.5 ms per round trip. Runs 1–3 gave 44/37/39 ms on create-and-refresh; the rerun near the threshold gave 61 ms, and five more runs gave 52/55/40/51/46 ms. One sample after about 5 minutes idle (descriptive only; whether Hyperdrive's origin connection or Neon was cold isn't known): open 2 ms, navigation 45 ms (13 added), create 73 ms (18 added), create-and-refresh 177 ms (52 added).

- **Verdict:** navigation isn't material (0 of 9 runs over 25 ms). Create-and-refresh sits at the threshold (median 46 ms, 4 of 9 runs over 50 ms). **Owner decision (2026-10-29): material, and the switch goes ahead anyway.** The switch to `app_runtime` doesn't change the wrapper's round-trip count (phase 1 has run in production since app 0.4.0, whatever the role); latency as `app_runtime` wasn't measured. Reopening per-request contexts (design B) or batching is the next M2 item after the switch.
- **As `app_runtime`** (G3, same preview reopened, 2026-10-29: `saas-pr-185` pointed at `app_runtime`, 3 runs × 200): added p50 per run 46/44/46 ms create-and-refresh, 19–21 ms navigation, 25–28 ms create; `select 1` 7 ms and an empty `inTenant` 20 ms at p50. The same as the owner's runs: on this preview the role doesn't change the cost.
- Runs: CI https://github.com/aaronbruiz/saas-foundation/actions/runs/40823876829, preview https://github.com/aaronbruiz/saas-foundation/actions/runs/40824314952, cleanup https://github.com/aaronbruiz/saas-foundation/actions/runs/40827360780 (`saas-pr-185` and `preview/pr-185` deleted, preview URL 404).
