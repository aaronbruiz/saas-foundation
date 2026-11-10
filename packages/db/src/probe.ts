// THROWAWAY, never merged: ADR-0043's and ADR-0044's release gates through the real connection layer
// on whatever `connectionString` points at: local Postgres in tests, Hyperdrive on a PR preview.
// Synthetic rows only, in a preview branch that's reset on every deploy and removed on close.
import { and, eq, sql } from 'drizzle-orm'
import {
  closeBillingAccess,
  deactivateAccount,
  gatedMemberWrite,
  isDeletedAccountViolation,
  reopenBillingAccess,
} from './account-deletion.ts'
import { createDb, rawDb, type Db } from './client.ts'
import { isOwnerGuardViolation } from './owner-guard.ts'
import { member, organization, session, user, verification } from './schema/auth.ts'
import { userDeletion } from './schema/account.ts'
import { ownTransaction, type Tx } from './tenant-transaction.ts'

export type ProbeCheck = { ok: boolean; observed: unknown }
export type ProbeResult = { ok: boolean; checks: Record<string, ProbeCheck> }
const check = (ok: boolean, observed: unknown): ProbeCheck => ({ ok, observed })

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const describe = (e: unknown) => {
  const chain: unknown[] = []
  for (let x = e; x instanceof Object; x = (x as { cause?: unknown }).cause)
    chain.push((x as { code?: unknown }).code)
  return {
    codes: chain.filter(Boolean),
    guard: isOwnerGuardViolation(e),
    deleted: isDeletedAccountViolation(e),
    message: String(e).slice(0, 200),
  }
}

/** Rejects when `p` hasn't settled within `ms`, so a stuck barrier can't hold a transaction open. */
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`probe timeout: ${what}`)), ms),
    ),
  ])

const BARRIER_MS = 10_000

/** A participant's result or its failure, handled from the start so a rejection is never unhandled. */
const settled = <T>(p: Promise<T>) =>
  p.then(
    (value) => value,
    (e: unknown) => ({ threw: describe(e) }),
  )

export async function deletionProbe(connectionString: string): Promise<ProbeResult> {
  const conns: { db: Db; close: () => Promise<void> }[] = []
  const open = async () => {
    const c = await createDb(connectionString)
    conns.push(c)
    return c.db
  }
  const checks: Record<string, ProbeCheck> = {}
  /** Barriers still holding a transaction open; released before the connections close. */
  const releases: (() => void)[] = []
  const run = crypto.randomUUID().slice(0, 8)
  const now = new Date()
  const newUser = async (db: Db, name: string) => {
    const id = `probe-${name}-${run}`
    await rawDb(db)
      .insert(user)
      .values({
        id,
        name: id,
        email: `${id}@probe.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
    return id
  }
  const newSession = (q: Tx, userId: string) => {
    const id = crypto.randomUUID()
    return q.insert(session).values({
      id,
      token: id,
      userId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
    })
  }
  /** This transaction's backend pid (Hyperdrive keeps one origin connection per transaction). */
  const pidOf = async (q: Tx) => {
    const res = (await q.execute(sql`select pg_backend_pid() as pid`)) as unknown as {
      rows: { pid: number }[]
    }
    return res.rows[0]!.pid
  }
  try {
    const main = await open()
    const raw = rawDb(main)
    /**
     * Polls until one of `blockers` blocks a backend: the one with `pid`, or one whose query matches
     * `like`. About 3 s at most, inside the 5 s statement timeout of the transactions it watches.
     */
    const blockedBy = async (blockers: number[], target: { pid?: number; like?: string }) => {
      const pid = target.pid ?? null
      const like = target.like ?? null
      const pids = sql.join(
        blockers.map((b) => sql`${b}::int`),
        sql`, `,
      )
      for (let i = 0; i < 30; i++) {
        const res = (await raw.execute(
          sql`select pid from pg_stat_activity
               where pg_blocking_pids(pid) && array[${pids}]
                 and (${pid}::int is null or pid = ${pid}::int)
                 and (${like}::text is null or query ilike ${like}::text)`,
        )) as unknown as { rows: { pid: number }[] }
        if (res.rows.length > 0) return res.rows[0]!.pid
        await new Promise((r) => setTimeout(r, 100))
      }
      return null
    }
    const { rows } = (await raw.execute(sql`show transaction_isolation`)) as unknown as {
      rows: { transaction_isolation: string }[]
    }
    checks.isolation_read_committed = check(
      rows[0]!.transaction_isolation === 'read committed',
      rows[0],
    )

    // Two owners demote themselves on two connections, both past their writes before either commits.
    // A participant that fails still releases its peer; a peer that never arrives times out.
    const orgId = `probe-org-${run}`
    await raw.insert(organization).values({ id: orgId, name: orgId, slug: orgId, createdAt: now })
    const [a, b] = [await newUser(main, 'a'), await newUser(main, 'b')]
    await raw.insert(member).values([
      { id: `m-a-${run}`, organizationId: orgId, userId: a, role: 'owner', createdAt: now },
      { id: `m-b-${run}`, organizationId: orgId, userId: b, role: 'owner', createdAt: now },
    ])
    const [c1, c2] = [await open(), await open()]
    const bothWrote = [deferred(), deferred()]
    const demote = (db: Db, memberId: string, i: number) =>
      ownTransaction(db, async (tx) => {
        try {
          await tx.update(member).set({ role: 'admin' }).where(eq(member.id, memberId))
        } finally {
          bothWrote[i]!.resolve()
        }
        await within(bothWrote[1 - i]!.promise, BARRIER_MS, 'owner race barrier')
      }).then(
        () => ({ committed: true }),
        (e: unknown) => ({ committed: false, ...describe(e) }),
      )
    const race = await Promise.all([demote(c1, `m-a-${run}`, 0), demote(c2, `m-b-${run}`, 1)])
    const owners = (
      await raw
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.organizationId, orgId), eq(member.role, 'owner')))
    ).length
    checks.owner_race_keeps_an_owner = check(
      owners === 1 &&
        race.filter((r) => r.committed).length === 1 &&
        race.some((r) => 'guard' in r && r.guard),
      { owners, race },
    )

    // The billing access gate, for an owner (so only the gate can refuse): an open gate writes, a
    // closed one refuses, a reopen by another attempt's token doesn't open it, its own does.
    const gateOrg = `probe-gate-org-${run}`
    await raw
      .insert(organization)
      .values({ id: gateOrg, name: gateOrg, slug: gateOrg, createdAt: now })
    const g = await newUser(main, 'gate')
    await raw.insert(member).values({
      id: `m-g-${run}`,
      organizationId: gateOrg,
      userId: g,
      role: 'owner',
      createdAt: now,
    })
    const written = () =>
      gatedMemberWrite(
        main,
        gateOrg,
        g,
        async () => 'sent',
        () => false,
      )
    const beforeClose = await written()
    const closed = await closeBillingAccess(main, g, 'one')
    const second = await closeBillingAccess(main, g, 'two')
    const whileClosed = await written()
    await reopenBillingAccess(main, g, 'two')
    const stillClosed = await written()
    await reopenBillingAccess(main, g, 'one')
    const reopened = await written()
    checks.gate_orders_writes = check(
      beforeClose.sent &&
        closed &&
        !second &&
        !whileClosed.sent &&
        !stillClosed.sent &&
        reopened.sent,
      { beforeClose, closed, second, whileClosed, stillClosed, reopened },
    )

    // A session insert in flight against a deactivation, in both orders. Each order is established
    // by who blocks whom: pg_blocking_pids on backend pids read inside each transaction.
    const deactivationQuery = '%for update%'

    // (a) The insert holds its lock first; the deactivation queues behind it and removes the session.
    const da = await newUser(main, 'del-a')
    const tokenA = crypto.randomUUID()
    await closeBillingAccess(main, da, tokenA)
    const [writerA, deleterA] = [await open(), await open()]
    const insertedA = deferred()
    const commitA = deferred()
    releases.push(commitA.resolve)
    let writerPidA = 0
    const writeA = ownTransaction(writerA, async (tx) => {
      writerPidA = await pidOf(tx)
      try {
        await newSession(tx, da)
      } finally {
        insertedA.resolve()
      }
      await within(commitA.promise, BARRIER_MS, 'insert-first commit')
    }).then(
      () => ({ inserted: true }),
      (e: unknown) => ({ inserted: false, ...describe(e) }),
    )
    await within(insertedA.promise, BARRIER_MS, 'insert-first insert')
    const deactivatingA = settled(deactivateAccount(deleterA, da, tokenA))
    const queuedA = await blockedBy([writerPidA], { like: deactivationQuery })
    commitA.resolve()
    const [wA, outcomeA] = await Promise.all([writeA, deactivatingA])
    const leftA = await raw.select({ id: session.id }).from(session).where(eq(session.userId, da))
    checks.insert_first_session_is_removed = check(
      queuedA !== null && wA.inserted && outcomeA === 'deactivated' && leftA.length === 0,
      { queuedA, write: wA, outcome: outcomeA, sessionsLeft: leftA.length },
    )

    // (b) The deactivation queues first behind a holder, then the insert queues (tuple locks are
    // granted in queue order), so the insert resumes only after the deactivation has committed:
    // the trigger has to refuse it.
    const d = await newUser(main, 'del')
    await newSession(raw, d)
    const token = crypto.randomUUID()
    await closeBillingAccess(main, d, token)
    const [holder, writer, deleter] = [await open(), await open(), await open()]
    const release = deferred()
    releases.push(release.resolve)
    const held = deferred()
    let holderPid = 0
    const holding = settled(
      ownTransaction(holder, async (tx) => {
        holderPid = await pidOf(tx)
        await tx.select({ id: user.id }).from(user).where(eq(user.id, d)).for('update')
        held.resolve()
        await within(release.promise, BARRIER_MS, 'holder release')
      }),
    )
    await within(held.promise, BARRIER_MS, 'holder lock')
    const deactivating = settled(deactivateAccount(deleter, d, token))
    const deleterPid = await blockedBy([holderPid], { like: deactivationQuery })
    const writerStarted = deferred()
    let writerPid = 0
    const inFlight = ownTransaction(writer, async (tx) => {
      writerPid = await pidOf(tx)
      writerStarted.resolve()
      await newSession(tx, d)
    }).then(
      () => ({ inserted: true }),
      (e: unknown) => ({ inserted: false, ...describe(e) }),
    )
    await within(writerStarted.promise, BARRIER_MS, 'writer start')
    const writerQueued =
      deleterPid !== null && (await blockedBy([deleterPid, holderPid], { pid: writerPid })) !== null
    release.resolve()
    const [held_, write, outcome] = await Promise.all([holding, inFlight, deactivating])
    const left = await raw.select({ id: session.id }).from(session).where(eq(session.userId, d))
    const ledger = await raw.select().from(userDeletion).where(eq(userDeletion.userId, d))
    checks.in_flight_session_doesnt_survive = check(
      deleterPid !== null &&
        !(held_ && typeof held_ === 'object' && 'threw' in held_) &&
        writerQueued &&
        !write.inserted &&
        'deleted' in write &&
        write.deleted &&
        outcome === 'deactivated' &&
        left.length === 0 &&
        ledger.length === 1,
      {
        deleterPid,
        holder: held_ ?? 'committed',
        writerQueued,
        write,
        outcome,
        sessionsLeft: left.length,
        ledger: ledger.length,
      },
    )

    // After it, each guarded table refuses with the named constraint, seen through this connection.
    const refused = async (write: () => Promise<unknown>) =>
      write().then(
        () => ({ refused: false }),
        (e: unknown) => ({ refused: isDeletedAccountViolation(e), ...describe(e) }),
      )
    const after = {
      session: await refused(() => newSession(raw, d)),
      member: await refused(() =>
        raw.insert(member).values({
          id: `m-d-${run}`,
          organizationId: orgId,
          userId: d,
          role: 'member',
          createdAt: now,
        }),
      ),
      verification: await refused(() =>
        raw.insert(verification).values({
          id: crypto.randomUUID(),
          identifier: `probe-${run}`,
          value: d,
          expiresAt: new Date(now.getTime() + 3_600_000),
          createdAt: now,
          updatedAt: now,
        }),
      ),
      user: await refused(() => raw.update(user).set({ name: 'after' }).where(eq(user.id, d))),
    }
    checks.trigger_refuses_each_table = check(
      Object.values(after).every((r) => r.refused),
      after,
    )
  } catch (e) {
    checks.probe_threw = check(false, describe(e))
  } finally {
    for (const r of releases) r()
    await Promise.all(conns.map((c) => c.close().catch(() => {})))
  }
  return { ok: Object.values(checks).every((c) => c.ok), checks }
}
