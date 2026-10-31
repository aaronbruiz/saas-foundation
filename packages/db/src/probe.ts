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
import { ownTransaction } from './tenant-transaction.ts'

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
  }
}

export async function deletionProbe(connectionString: string): Promise<ProbeResult> {
  const conns: { db: Db; close: () => Promise<void> }[] = []
  const open = async () => {
    const c = await createDb(connectionString)
    conns.push(c)
    return c.db
  }
  const checks: Record<string, ProbeCheck> = {}
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
  const newSession = (db: Db, userId: string) => {
    const id = crypto.randomUUID()
    return rawDb(db)
      .insert(session)
      .values({
        id,
        token: id,
        userId,
        expiresAt: new Date(now.getTime() + 3_600_000),
        createdAt: now,
        updatedAt: now,
      })
  }
  try {
    const main = await open()
    const raw = rawDb(main)
    const { rows } = (await raw.execute(sql`show transaction_isolation`)) as unknown as {
      rows: { transaction_isolation: string }[]
    }
    checks.isolation_read_committed = check(
      rows[0]!.transaction_isolation === 'read committed',
      rows[0],
    )

    // Two owners demote themselves on two connections, both past their writes before either commits.
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
        await tx.update(member).set({ role: 'admin' }).where(eq(member.id, memberId))
        bothWrote[i]!.resolve()
        await bothWrote[1 - i]!.promise
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

    // The billing access gate: closed refuses, a reopen by another token doesn't, its own does.
    const g = await newUser(main, 'gate')
    const written = () =>
      gatedMemberWrite(
        main,
        orgId,
        g,
        async () => 'sent',
        () => false,
      )
    const closed = await closeBillingAccess(main, g, 'one')
    const second = await closeBillingAccess(main, g, 'two')
    const whileClosed = await written()
    await reopenBillingAccess(main, g, 'two')
    const stillClosed = await written()
    await reopenBillingAccess(main, g, 'one')
    checks.gate_orders_writes = check(closed && !second && !whileClosed.sent && !stillClosed.sent, {
      closed,
      second,
      whileClosed,
      stillClosed,
    })

    // A session insert waiting on the user's lock, and a real deactivation behind it.
    const d = await newUser(main, 'del')
    await newSession(main, d)
    const token = crypto.randomUUID()
    await closeBillingAccess(main, d, token)
    const [holder, writer, deleter] = [await open(), await open(), await open()]
    const release = deferred()
    const held = deferred()
    const holding = ownTransaction(holder, async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, d)).for('update')
      held.resolve()
      await release.promise
    })
    await held.promise
    const inFlight = newSession(writer, d).then(
      () => ({ inserted: true }),
      (e: unknown) => ({ inserted: false, ...describe(e) }),
    )
    let waited = false
    for (let i = 0; i < 100 && !waited; i++) {
      const res = (await raw.execute(
        sql`select count(*)::int as n from pg_stat_activity
             where wait_event_type = 'Lock' and datname = current_database()`,
      )) as unknown as { rows: { n: number }[] }
      waited = res.rows[0]!.n > 0
      if (!waited) await new Promise((r) => setTimeout(r, 100))
    }
    const deactivating = deactivateAccount(deleter, d, token)
    release.resolve()
    await holding
    const [write, outcome] = await Promise.all([inFlight, deactivating])
    const left = await raw.select({ id: session.id }).from(session).where(eq(session.userId, d))
    const ledger = await raw.select().from(userDeletion).where(eq(userDeletion.userId, d))
    checks.in_flight_session_doesnt_survive = check(
      waited && outcome === 'deactivated' && left.length === 0 && ledger.length === 1,
      { waited, write, outcome, sessionsLeft: left.length, ledger: ledger.length },
    )

    // After it, each guarded table refuses with the named constraint, seen through this connection.
    const refused = async (write: () => Promise<unknown>) =>
      write().then(
        () => ({ refused: false }),
        (e: unknown) => ({ refused: isDeletedAccountViolation(e), ...describe(e) }),
      )
    const after = {
      session: await refused(() => newSession(main, d)),
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
    checks.probe_threw = check(false, { ...describe(e), message: String(e).slice(0, 300) })
  } finally {
    await Promise.all(conns.map((c) => c.close().catch(() => {})))
  }
  return { ok: Object.values(checks).every((c) => c.ok), checks }
}
