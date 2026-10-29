// THROWAWAY (ADR-0040 decision 8, check (d), roadmap M2; owner decision 2026-10-29): never merged.
// Times the R04 critical paths through the real createDb → GuardedClient → inTenant on whatever
// `connectionString` points at: local Postgres in tests, Hyperdrive on a PR preview.
//
// An unwrapped path can't run (GuardedClient refuses `project` outside inTenant), so the added cost
// is estimated per sample: right after each path sample, a matched sample runs, on the same client,
// one empty inTenant call (BEGIN, set_config, COMMIT: +3) per newly wrapped call and one `select 1`
// (+1) per call that was already a transaction (createWithinLimit). Estimated baseline = path minus
// its matched sample, per sample; percentiles are taken afterwards.
//
// Writes one synthetic organization (with a membership and projects) and one session, deleted at
// the end, and one fixed probe user (`probe-user`, created once).
import { eq } from 'drizzle-orm'
import { createDb, rawDb, type Db } from './client.ts'
import { billing } from './billing.ts'
import { member, organization, session, user } from './schema/auth.ts'
import { findMembership, findOrganizationBySlug, projects } from './tenancy.ts'
import { inTenant } from './tenant-transaction.ts'

type Client = { query: (sql: string) => Promise<unknown> }
const client = (db: Db) => (rawDb(db) as unknown as { $client: Client }).$client

export type PathSamples = { path: number[]; matched: number[] }
export type LatencyResult = {
  n: number
  openMs: number
  timerStepMs: number | null
  paths: { navigation: PathSamples; create: PathSamples; createAndRefresh: PathSamples }
  info: { selectOneMs: number[]; emptyInTenantMs: number[] }
}

const timed = async (fn: () => Promise<unknown>) => {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

export async function latencyProbe(connectionString: string, n: number): Promise<LatencyResult> {
  const run = crypto.randomUUID().slice(0, 8)
  const [orgId, slug, userId] = [`probe-l-${run}`, `probe-l-${run}`, 'probe-user']
  const [sessionId, token] = [`probe-s-${run}`, `probe-t-${run}`]
  const scope = { orgId }

  let openMs = 0
  const opened: { db: Db; close: () => Promise<void> }[] = []
  const open = async () => {
    const start = performance.now()
    const handle = await createDb(connectionString)
    opened.push(handle)
    openMs ||= performance.now() - start
    return handle.db
  }

  try {
    const db = await open()
    const now = new Date()
    await rawDb(db)
      .insert(user)
      .values({
        id: userId,
        name: 'probe',
        email: `${userId}@probe.invalid`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
    await rawDb(db).insert(organization).values({ id: orgId, name: orgId, slug, createdAt: now })
    await rawDb(db)
      .insert(member)
      .values({
        id: `probe-m-${run}`,
        organizationId: orgId,
        userId,
        role: 'owner',
        createdAt: now,
      })
    await rawDb(db)
      .insert(session)
      .values({
        id: sessionId,
        token,
        userId,
        expiresAt: new Date(now.getTime() + 3_600_000),
        createdAt: now,
        updatedAt: now,
      })
    await projects(db, scope).createWithinLimit({ name: 'seed' }, userId, null)
    // The refresh's two loaders run as parallel requests, each on its own client (R04 §2.2).
    const [db2, db3] = [await open(), await open()]

    const wrapper = (d: Db) => inTenant(d, scope, async () => undefined)
    const roundTrip = (d: Db) => client(d).query('select 1')
    // getTenantContext: Better Auth's in-app getSession (session read, then user read; R04 §2.2),
    // then organization and membership.
    const tenant = async (d: Db) => {
      const [s] = await rawDb(d).select().from(session).where(eq(session.token, token)).limit(1)
      const [u] = s ? await rawDb(d).select().from(user).where(eq(user.id, s.userId)).limit(1) : []
      if (!u) throw new Error('probe session')
      const org = await findOrganizationBySlug(d, slug)
      if (!org || !(await findMembership(d, org.id, userId))) throw new Error('probe fixture')
      return org
    }
    // Create as the app does it: context, entitlements read (+3), createWithinLimit (+1).
    const create = async () => {
      await tenant(db)
      await billing(db, scope).subscription()
      const created = await projects(db, scope).createWithinLimit({ name: 'p' }, userId, 1_000_000)
      if (!created) throw new Error('probe create')
      return created.id
    }

    const navigation: PathSamples = { path: [], matched: [] }
    const createPath: PathSamples = { path: [], matched: [] }
    const createAndRefresh: PathSamples = { path: [], matched: [] }
    const info = { selectOneMs: [] as number[], emptyInTenantMs: [] as number[] }
    const created: string[] = []

    for (let i = 0; i < n; i++) {
      navigation.path.push(
        await timed(async () => {
          await tenant(db)
          await projects(db, scope).list()
        }),
      )
      navigation.matched.push(await timed(() => wrapper(db)))

      createPath.path.push(await timed(async () => created.push(await create())))
      createPath.matched.push(
        await timed(async () => {
          await wrapper(db)
          await roundTrip(db)
        }),
      )

      // Critical path: the create, then the slower of the two parallel loaders (the list).
      createAndRefresh.path.push(
        await timed(async () => {
          created.push(await create())
          await Promise.all([
            tenant(db2),
            (async () => {
              await tenant(db3)
              await projects(db3, scope).list()
            })(),
          ])
        }),
      )
      createAndRefresh.matched.push(
        await timed(async () => {
          await wrapper(db)
          await roundTrip(db)
          await wrapper(db3)
        }),
      )

      info.selectOneMs.push(await timed(() => roundTrip(db)))
      info.emptyInTenantMs.push(await timed(() => wrapper(db)))
      // Keep the list the same size across samples (removal is untimed).
      while (created.length) await projects(db, scope).remove(created.pop()!)
    }

    const steps = [...info.selectOneMs, ...info.emptyInTenantMs].filter((x) => x > 0)
    return {
      n,
      openMs,
      timerStepMs: steps.length ? Math.min(...steps) : null,
      paths: { navigation, create: createPath, createAndRefresh },
      info,
    }
  } finally {
    await Promise.allSettled(opened.map((h) => h.close()))
    // A fresh connection: a measurement connection may be unusable by now.
    const cleanup = await createDb(connectionString)
    try {
      // Organization delete cascades to its membership and projects (archived, ADR-0039).
      await rawDb(cleanup.db).delete(organization).where(eq(organization.id, orgId))
      await rawDb(cleanup.db).delete(session).where(eq(session.id, sessionId))
    } finally {
      await cleanup.close()
    }
  }
}
