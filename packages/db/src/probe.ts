// THROWAWAY (ADR-0040 decision 8, check (d) re-measured after #189, roadmap M2): never merged.
// A/B: each sample runs the create as before #189 (`old`: a separate subscription read, then the
// old lock/count/insert body, copied below) and as now (`new`: createWithinLimit reads the
// subscription inside its transaction), alternating which goes first. Saving = old - new.
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
import { count, eq } from 'drizzle-orm'
import { createDb, rawDb, type Db } from './client.ts'
import { billing } from './billing.ts'
import { member, organization, session, user } from './schema/auth.ts'
import { project } from './schema/projects.ts'
import { findMembership, findOrganizationBySlug, projects } from './tenancy.ts'
import { inTenant } from './tenant-transaction.ts'

type Client = { query: (sql: string) => Promise<unknown> }
const client = (db: Db) => (rawDb(db) as unknown as { $client: Client }).$client

export type PathSamples = { path: number[]; matched: number[] }
export type LatencyResult = {
  n: number
  openMs: number
  timerStepMs: number | null
  paths: {
    navigation: PathSamples
    createOld: PathSamples
    createNew: PathSamples
    createAndRefreshOld: PathSamples
    createAndRefreshNew: PathSamples
  }
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
    await projects(db, scope).createWithinLimit({ name: 'seed' }, userId, () => null)
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
    // Before #189: context, entitlements read (+3), then the old createWithinLimit body (+1).
    const createOld = async () => {
      await tenant(db)
      await billing(db, scope).subscription()
      const created = await inTenant(db, scope, async (tx) => {
        await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, orgId))
          .for('no key update')
        const [row] = await tx
          .select({ n: count() })
          .from(project)
          .where(eq(project.organizationId, orgId))
        if ((row?.n ?? 0) >= 1_000_000) return null
        const [p] = await tx
          .insert(project)
          .values({ name: 'p', organizationId: orgId, createdBy: userId })
          .returning()
        return p ?? null
      })
      if (!created) throw new Error('probe create')
      return created.id
    }
    // Since #189 (as the app does it): context, then createWithinLimit reading the plan inside (+1).
    const createNew = async () => {
      await tenant(db)
      const created = await projects(db, scope).createWithinLimit(
        { name: 'p' },
        userId,
        () => 1_000_000,
      )
      if (!created) throw new Error('probe create')
      return created.id
    }
    // The refresh's two loaders, in parallel on their own clients; the list is the slower one.
    const refresh = () =>
      Promise.all([
        tenant(db2),
        (async () => {
          await tenant(db3)
          await projects(db3, scope).list()
        })(),
      ])

    const samples = () => ({ path: [] as number[], matched: [] as number[] })
    const navigation = samples()
    const [cOld, cNew, rOld, rNew] = [samples(), samples(), samples(), samples()]
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

      // Matched samples: old create +3 +1, new create +1; the refresh's list adds +3 to both.
      const variants = [
        {
          run: async () => {
            cOld.path.push(await timed(async () => created.push(await createOld())))
            cOld.matched.push(await timed(async () => (await wrapper(db), await roundTrip(db))))
            rOld.path.push(
              await timed(async () => (created.push(await createOld()), await refresh())),
            )
            rOld.matched.push(
              await timed(async () => (await wrapper(db), await roundTrip(db), await wrapper(db3))),
            )
          },
        },
        {
          run: async () => {
            cNew.path.push(await timed(async () => created.push(await createNew())))
            cNew.matched.push(await timed(() => roundTrip(db)))
            rNew.path.push(
              await timed(async () => (created.push(await createNew()), await refresh())),
            )
            rNew.matched.push(await timed(async () => (await roundTrip(db), await wrapper(db3))))
          },
        },
      ]
      if (i % 2) variants.reverse()
      for (const v of variants) {
        await v.run()
        // Keep the list the same size across samples (removal is untimed).
        while (created.length) await projects(db, scope).remove(created.pop()!)
      }

      info.selectOneMs.push(await timed(() => roundTrip(db)))
      info.emptyInTenantMs.push(await timed(() => wrapper(db)))
    }

    const steps = [...info.selectOneMs, ...info.emptyInTenantMs].filter((x) => x > 0)
    return {
      n,
      openMs,
      timerStepMs: steps.length ? Math.min(...steps) : null,
      paths: {
        navigation,
        createOld: cOld,
        createNew: cNew,
        createAndRefreshOld: rOld,
        createAndRefreshNew: rNew,
      },
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
