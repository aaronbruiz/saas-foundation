// THROWAWAY (ADR-0040 preview checks, M1 done-when 2; owner decision 2026-10-21, option A1): never
// merged. Runs (a)–(c) and (e) through the real createDb → GuardedClient → inTenant on whatever
// `connectionString` points at: local Postgres in tests, Hyperdrive on a PR preview. Writes only
// two synthetic organizations and their projects, deleted at the end, and one fixed probe user
// (`probe-user`, created once: the runtime role can't delete users).
import { inArray } from 'drizzle-orm'
import { createDb, rawDb, type Db } from './client.ts'
import { project, organization, user } from './schema/index.ts'
import { inTenant } from './tenant-transaction.ts'
import { projects } from './tenancy.ts'

type Client = {
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>
  getTransactionStatus: () => string | null
}
const client = (db: Db) => (rawDb(db) as unknown as { $client: Client }).$client
const context = async (db: Db) =>
  ((await client(db).query("select current_setting('app.org_id', true) as v")).rows[0]!.v as
    | string
    | null) || null
const backend = async (db: Db) =>
  Number((await client(db).query('select pg_backend_pid() as p')).rows[0]!.p)
const status = (db: Db) => client(db).getTransactionStatus()

export type ProbeCheck = { ok: boolean; observed: unknown }
export type ProbeResult = { ok: boolean; checks: Record<string, ProbeCheck> }

const check = (ok: boolean, observed: unknown): ProbeCheck => ({ ok, observed })

export async function hyperdriveProbe(connectionString: string): Promise<ProbeResult> {
  const open = () => createDb(connectionString)
  const checks: Record<string, ProbeCheck> = {}
  const run = crypto.randomUUID().slice(0, 8)
  const [orgA, orgB, creator] = [`probe-a-${run}`, `probe-b-${run}`, 'probe-user']

  // Cleanup covers fixture setup too: organizations committed before a failed project insert go.
  try {
    const fixtures = await open()
    try {
      const now = new Date()
      await rawDb(fixtures.db)
        .insert(user)
        .values({
          id: creator,
          name: 'probe',
          email: `${creator}@probe.invalid`,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
      await rawDb(fixtures.db)
        .insert(organization)
        .values([orgA, orgB].map((id) => ({ id, name: id, slug: id, createdAt: now })))
      for (const orgId of [orgA, orgB])
        await inTenant(fixtures.db, { orgId }, (tx) =>
          tx
            .insert(project)
            .values({ organizationId: orgId, name: `p-${orgId}`, createdBy: creator }),
        )
    } finally {
      await fixtures.close()
    }

    const { db, close } = await open()
    try {
      // (a) + (c): context and status inside, after COMMIT, after ROLLBACK, on the same client.
      const inside = await inTenant(db, { orgId: orgA }, async () => ({
        context: await context(db),
        status: status(db),
        backend: await backend(db),
      }))
      const afterCommit = {
        context: await context(db),
        status: status(db),
        backend: await backend(db),
      }
      let insideRollback: string | null = null
      await inTenant(db, { orgId: orgB }, async () => {
        insideRollback = await context(db)
        throw new Error('probe rollback')
      }).catch((e: unknown) => {
        if (!(e instanceof Error && e.message === 'probe rollback')) throw e
      })
      const afterRollback = { context: await context(db), status: status(db) }
      checks.a_context_inside = check(inside.context === orgA, inside.context)
      checks.a_context_after_commit = check(afterCommit.context === null, afterCommit.context)
      checks.a_context_inside_rolled_back_call = check(insideRollback === orgB, insideRollback)
      checks.a_context_after_rollback = check(afterRollback.context === null, afterRollback.context)
      checks.c_status_inside = check(inside.status === 'T', inside.status)
      checks.c_status_after_commit = check(afterCommit.status === 'I', afterCommit.status)
      checks.c_status_after_rollback = check(afterRollback.status === 'I', afterRollback.status)
      checks.info_backend_pids = check(true, {
        inside: inside.backend,
        afterCommit: afterCommit.backend,
      })

      // (b): a write followed by a failure leaves nothing.
      const name = `failed-${run}`
      const failed = await inTenant(db, { orgId: orgA }, async (tx) => {
        await tx.insert(project).values({ organizationId: orgA, name, createdBy: creator })
        throw new Error('probe failure')
      }).then(
        () => 'committed',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
      const leaked = (await projects(db, { orgId: orgA }).list()).filter((p) => p.name === name)
      checks.b_failed_write_leaves_nothing = check(
        failed === 'probe failure' && leaked.length === 0 && status(db) === 'I',
        { failed, rowsFound: leaked.length, status: status(db) },
      )

      // (e) sequential: alternation on one client (concurrent calls on one Db are refused by design).
      const sequence: unknown[] = []
      let sequentialOk = true
      for (let i = 0; i < 20; i++) {
        const orgId = i % 2 ? orgB : orgA
        const seen = await inTenant(db, { orgId }, () => context(db))
        const rows = await projects(db, { orgId }).list()
        const between = await context(db)
        const ok =
          seen === orgId &&
          between === null &&
          rows.length > 0 &&
          rows.every((p) => p.organizationId === orgId)
        sequentialOk &&= ok
        if (!ok) sequence.push({ i, orgId, seen, between, orgs: rows.map((p) => p.organizationId) })
      }
      checks.e_alternating_one_client = check(
        sequentialOk,
        sequence.length ? sequence : '20/20 own rows only',
      )
    } finally {
      await close()
    }

    // (e) concurrent: 100 requests, 6 at a time (Workers' simultaneous-connection limit), each on
    // its own Db handle, alternating tenants.
    const request = async (i: number) => {
      const orgId = i % 2 ? orgB : orgA
      const own = await open()
      try {
        const seen = await inTenant(own.db, { orgId }, () => context(own.db))
        const rows = await projects(own.db, { orgId }).list()
        return seen === orgId && rows.length > 0 && rows.every((p) => p.organizationId === orgId)
      } finally {
        await own.close()
      }
    }
    const results: boolean[] = []
    for (let start = 0; start < 100; start += 6)
      results.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(6, 100 - start) }, (_, k) => request(start + k)),
        )),
      )
    const failures = results.flatMap((ok, i) => (ok ? [] : [i]))
    checks.e_alternating_separate_clients = check(
      results.length === 100 && failures.length === 0,
      failures.length ? { failures } : '100/100 own rows only',
    )

    return { ok: Object.values(checks).every((c) => c.ok), checks }
  } finally {
    // Organization delete cascades to their projects (and archives them, ADR-0039).
    const cleanup = await open()
    try {
      await rawDb(cleanup.db)
        .delete(organization)
        .where(inArray(organization.id, [orgA, orgB]))
    } finally {
      await cleanup.close()
    }
  }
}
