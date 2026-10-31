# ADR-0044: Self-service account deactivation, purge after 90 days, and a billing access gate

Status: Accepted for the smoke-test-only environment (owner 2026-10-31) · Date: 2026-10-31

Owner 2026-10-31: approves this design for the current smoke-test-only environment, including its documented restore and operator-recovery limits. Before admitting real customers: resolve deletion-history durability, restore exposure and retention exceptions, alongside legal review. Hyperdrive and Polar sandbox checks remain release gates. It's a new security ADR during the roadmap's freeze, as an owner-approved exception.

## Context

The privacy page offered deletion by writing to us. The roadmap's foundation features add it self-service. The owner chose: a sole owner is refused until they transfer or delete; the account stops working at once; its data is removed after about three months; someone returning with the same email starts clean.

Better Auth's `/delete-user` deletes the row at once, and `app_runtime` has no `DELETE` on `user` (ADR-0038), so the app needs its own path. Three things make "stops working" harder than it looks:

- **Deleting sessions stops new requests, not one that authenticated before and writes after.**
- **Polar has no conditional writes or idempotency** (ADR-0043). A member create already sent can't be stopped, so one racing the caller's leave could land after the revoke, and leave a deleted user with billing access.
- **A restore can bring a deactivated account back.**

## Decision

### 1. Three stages

1. **Deactivation, immediately.** `POST /api/auth/delete-account` checks the password and that the caller is nobody's sole owner, closes their billing access, leaves each organization through Better Auth (owned ones first, so ADR-0022's hooks run and a refusal comes early), then in one transaction: locks the user row, refuses if a member row remains or the gate isn't held, swaps the email for `<id>@deleted.invalid`, nulls the password and OAuth tokens, deletes sessions and verification rows, and inserts into `user_deletion`.
2. **Purge eligibility, after 90 days.** The owner's monthly manual purge (runbook "Account deletion") removes the user and their archived rows.
3. **Copies, with exceptions.** Dumps and branches keep data longer; see "Retention".

It isn't atomic, for the same reason as a transfer: each leave goes through the hooks. A refusal part-way answers what was left; the account keeps working, and a retry finishes. The same email can sign up the moment the transaction commits, as a new, empty account. Nothing restores the old one. No confirmation email is sent (owner: another delivery and failure path, not needed for the guarantee).

The endpoint is a Better Auth plugin, not a server function: it has to go through the HTTP handler to be rate limited (ADR-0005), and Better Auth's `/verify-password` is server-only. It has its own explicit rule in `rateLimit.customRules`, since the handler alone would give it the default 100 per 60 s.

### 2. Writes after deactivation are refused in the database

`refuse_deleted_user`, a `BEFORE` row trigger, takes `FOR KEY SHARE` on the user, then, in a separate statement so it reads a fresh snapshot after waiting, refuses with constraint `user_not_deleted` if `user_deletion` has that id. On `user`, `session`, `account`, `member` and `verification` (`value`, which has no foreign key) for inserts and updates; on `project` (creator) for inserts, so the purge's `SET NULL` passes; on `invitation` for inserts and changes of `inviter_id`, so people can still answer an invitation a deleted user sent.

**How it holds.** The deactivation holds `FOR UPDATE` on the user. A write that got its lock first commits first, and the deactivation's later statements see it. A later one waits and is refused. The ledger's row is the transaction's last statement, so its own writes pass.

**Deadlocks are possible and fail closed.** A `BEFORE UPDATE` trigger runs after Postgres has locked the target row, so an in-flight password change can hold its row and wait for the user lock while the deactivation holds that and waits for the row. Postgres aborts one, and nothing partial commits. If the deactivation loses: 409, and a retry finishes.

**Anything else that passed its authorization before the leave counts as having run before the deletion**: a read, or a rename or delete by a then-valid owner. That's the same window as any removed member today, and no new state attaches to the account.

**Limits.** Creating an organization in flight inserts the organization and its member in separate statements (ADR-0043), so the member is refused and an empty, unreachable organization remains. It holds none of the user's data; the ownerless query finds it. Email verification links are signed JWTs and can't be revoked: they name the old email, so they only verify that mailbox's own new account, for up to an hour. A reset request whose write committed before the deactivation can still send a link, which no longer works. A new social provider isn't certified by this; adding one reruns the inventory in the PR's Behaviour. The trigger assumes READ COMMITTED, like ADR-0043's guard; nothing here sets another level.

A new table with a foreign key to `user` needs the trigger: a catalog test finds any without it.

### 3. The billing access gate

`billing_access_gate`, one row per user, orders writes of that user into the provider against the deletion. No clock decides safety. It's ADR-0043's pattern.

- **Every path goes through it:** the membership hooks' grant, checkout and portal (`ensureMember`, and `ensureCustomer` with its embedded owner), and another owner's revoke, which can create or promote this user as successor.
- **Write:** raise `writes_in_flight` unless closed or deactivated; then, a fresh read that this user is still an owner, since authorization from before the gate counts for nothing. Closed, or no longer an owner: nothing is sent, and the count comes back down. The count comes down when the outcome is known: the write answered, or Polar refused it. A network error or 5xx stays counted (`MemberWriteUnknown`).
- **Close,** before any leave: set `closed_by` to this attempt's token, only with nothing in flight and nobody else holding it.
- **Reopen:** an attempt that stops clears its own token.
- **Deactivation is terminal:** the finishing transaction requires its own token with nothing in flight, and sets `deactivated_at`. Nothing changes the gate after that.

**Why that's enough.** A write that passes its fresh read happened before that organization's leave, because a deletion's leaves only run after the close, and the close needs nothing in flight. So it has answered before the revoke runs, and the revoke sees it. A write acquiring after a leave, including after a reopen, fails the fresh read, so a retry with no memberships left has nothing to revoke. After deactivation no write starts. A paused write either keeps the close refusing, or never sends.

**What it costs, each a separately authorized risk override rather than recovery:**

- A write with an unknown outcome blocks this user's deletion until an operator clears it. A request that never answered could still land, leaving a Polar member for a deleted user.
- A crash between the close and the end leaves the gate closed on a working account: its checkout, portal and further deletion attempts answer 409 until an operator reopens it. No clock reopens it, since nothing proves the old request has stopped.

**Not ordered by the gate:** a write racing an ordinary leave or demotion, long before any deletion, can leave a Polar member behind in an organization the user already left. That's today's behaviour. The purge's Polar check covers those organizations.

### 4. Retention

| Where the data is           | How long, after the deletion                         | Source                         |
| --------------------------- | ---------------------------------------------------- | ------------------------------ |
| Live tables, archive        | 90 days, plus up to about 31 until the next purge    | ADR-0039                       |
| R2 dumps                    | About 30 more, by lifecycle rule, typically +1 day   | ADR-0023, Cloudflare's R2 docs |
| `backup-YYYYMMDD` snapshots | Newest 3 kept, only while backups run                | Runbook                        |
| Neon point-in-time history  | 6 h                                                  | ADR-0003                       |
| Request logs                | 7 days; no user data, except the hash in decision 6  | ADR-0015                       |
| **Expected worst case**     | **90 + 31 + 30 = about 151 days, plus a day or two** |                                |

**That's an expectation, not a limit.** It holds only while the owner runs the purge monthly and old branches can be deleted; nothing enforces it, and nothing alerts on a missed run. The newest `pre-migrate-*` branch is kept until the next release (ADR-0029), so with no release it holds full data indefinitely, and `main-before-*` branches stay until someone deletes them. The purge's runbook step deletes such branches older than 30 days. **Some can't be deleted:** a `main-before-restore-*` branch can be an ancestor of production. One that can't go is recorded as an open retention exception, and the figure doesn't hold for the accounts in it. Polar's and the email provider's own records aren't covered.

A written erasure request runs the purge at once, without the 90 days (owner decision). Legal wording stays provisional pending review.

### 5. Restores

**A restore can undo a recent deactivation.** One found in surviving history is reapplied, before traffic reaches the restored database where the procedure allows it. One with no surviving history comes back as a working account, can't be identified, and stays that way until the user deletes again. Nothing promises to notify anyone.

- **`user_deletion` outlives the purge.** No foreign key, only the id and times. A row is removed only when no recoverable copy can hold that identity: at least 35 days after `purged_at`, and purged before the oldest surviving branch was made. While it exists, the trigger refuses selective recovery of that user's rows; the runbook's recovery procedures gain a staging step, so one such row doesn't abort restoring the rest of an organization.
- **Replay** (`replay_account_deletion`, owner only, runbook) reapplies the changes and keeps the original time. It holds the user's lock first and closes the gate conditionally, as the deactivation does. It stops at a restored in-flight count or close, and the guard stops it at a restored sole owner. It removes memberships by SQL: a narrow exception to ADR-0022's hooks, because Polar wasn't rolled back and the original revoke stands. The operator checks each organization's Polar members afterwards.
- **There's no maintenance mode.** A promote or dump restore can replay before Hyperdrive points at it. An in-place point-in-time restore is live at once: until the replay, a deleted account can sign in with its old password.
- **Sources of history, in order:** `user_deletion` in the newest surviving copy, complete up to that copy; then the log event in decision 6, for the time after it.
- **With neither,** nothing identifies those users. Polar's missing member is only a hint, for owners alone, never grounds to delete. The only way to reach them is a message to every account in the restored database, the owner's call during the incident; nothing here builds it.

A deletion store outside the database and logs would close this, but needs a new binding and an ADR (invariant 14). Not proposed while production holds only smoke-test accounts; it's one of the conditions before real customers.

### 6. A narrow exception to ADR-0015

`account.deleted` carries `subject_sha256`, the SHA-256 of the user id, through the existing logger, after the deactivation commits. No email, name, credentials or tokens. It's a linkable identifier: alone it identifies nobody, and an operator matches it by hashing a restored database's ids.

It's **best-effort recovery evidence, never a complete deletion ledger**: a Worker dying right after the commit writes nothing, and retention bounds it. It's written as a log field, which the logger doesn't redact; through `logBetterAuth`'s message path, `redact` would remove it, as a long opaque string. A test pins both.

## Alternatives

- **Better Auth's `/delete-user`, or an immediate purge.** Rejected: the owner chose a retention window, and a hard delete needs a `DELETE` grant the runtime role doesn't have.
- **Keep the email, and intercept sign-up to wipe the old account.** Rejected: more code on a path Better Auth owns, and a race with verification. A tombstone frees the address at once.
- **A `deleted_at` column on `user`.** Rejected: the table is generated, the column would reach the session payload, and it wouldn't survive the purge, which a restore needs.
- **Revoke again after the leave commits, with a compensating read after each grant.** Rejected: a failed compensation needs durable tracking anyway, and a retry has no list of organizations to revisit.
- **Durable cleanup tracking instead of the fresh read.** Rejected: already-authorized writes have no reason to proceed once the membership is gone.
- **Reopen a stale close by time.** Rejected, as in ADR-0043: nothing proves remote or paused work has stopped.
- **Disabling hooks with `session_replication_role`, or a maintenance mode, for replay.** Not built: replay is a rare owner procedure.

## Consequences

- New SQL-only objects (`refuse_deleted_user` and its triggers, `purge_deleted_account`, `replay_account_deletion`), registered in `packages/db/sql-only-objects.tsv`, and two tables with explicit grants (ADR-0038).
- `project.created_by` is nullable with `ON DELETE SET NULL`. Old code keeps working, but `DROP NOT NULL` counts as a contract migration (`scripts/contract-migrations.sh`): rolling back past it needs `confirm_breaking`, and the title has `!`.
- A busy or unknown Polar write can refuse a deletion; a closed gate can refuse checkout and portal.
- Restores gain a required step (runbook "After a restore", ADR-0038).
