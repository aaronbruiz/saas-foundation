import { beforeAll, describe, expect, it } from 'vitest'
import { billing, createDb, findOrganizationBySlug, projects, type Db } from '@saas-foundation/db'
import { inTenant, rawDb, schema, TenantTransactionError } from '@saas-foundation/db/internal'
import { env } from 'cloudflare:workers'
import { withDb } from '../src/server/db'
import { createProject } from '../src/modules/projects/service'
import { createOrg, signUp } from './helpers'

// ADR-0040 phase 1: every tenant-scoped repository call runs in its own transaction with the
// tenant set transaction-locally, and refuses to start while the client is already in one.

let orgA: string
let orgB: string
let creator: string

const orgId = async (slug: string) => (await withDb((db) => findOrganizationBySlug(db, slug)))!.id

// Direct SQL for assertions only (apps/app doesn't depend on drizzle-orm).
type Client = {
  query: (sql: string) => Promise<{ rows: { v: string | null }[] }>
  getTransactionStatus: () => string | null
}
const client = (db: Db) => (rawDb(db) as unknown as { $client: Client }).$client

/**
 * The tenant context the next statement on this client sees (null when none). Inside a tenant
 * call it runs on the same connection, so it reads that transaction's setting.
 */
const context = async (db: Db) =>
  (await client(db).query(`select current_setting('app.org_id', true) as v`)).rows[0]!.v || null

const status = (db: Db) => client(db).getTransactionStatus()

beforeAll(async () => {
  const [alice, bob] = await Promise.all([signUp(), signUp()])
  creator = alice.userId
  const [a, b] = await Promise.all([createOrg(alice, 'a'), createOrg(bob, 'b')])
  await createProject(alice.headers, { tenant: a, project: { name: 'Alpha' } })
  await createProject(bob.headers, { tenant: b, project: { name: 'Beta' } })
  ;[orgA, orgB] = await Promise.all([orgId(a), orgId(b)])
})

describe('tenant transactions refuse to run inside another transaction', () => {
  it('a tenant read while another transaction is open on the client is refused, and that transaction still rolls back everything', async () => {
    const name = `outer-${crypto.randomUUID()}`
    await withDb(async (db) => {
      // Shaped like Better Auth's adapter transaction (#155) calling one of our hooks.
      const outer = rawDb(db).transaction(async (tx) => {
        await tx.insert(schema.project).values({ organizationId: orgA, name, createdBy: creator })
        await expect(billing(db, { orgId: orgA }).subscription()).rejects.toThrow(
          TenantTransactionError,
        )
        await expect(projects(db, { orgId: orgA }).list()).rejects.toThrow(TenantTransactionError)
        throw new Error('outer failure')
      })
      await expect(outer).rejects.toThrow('outer failure')
      expect(status(db)).toBe('I')
      const left = await projects(db, { orgId: orgA }).list()
      expect(left.some((p) => p.name === name)).toBe(false)
    })
  })

  it('a tenant call inside another tenant call is refused', async () => {
    await withDb((db) =>
      inTenant(db, { orgId: orgA }, async () => {
        await expect(inTenant(db, { orgId: orgB }, async () => null)).rejects.toThrow(
          TenantTransactionError,
        )
        await expect(projects(db, { orgId: orgB }).count()).rejects.toThrow(TenantTransactionError)
      }),
    )
  })

  it('two tenant calls started together on one client: one runs, the other is refused', async () => {
    await withDb(async (db) => {
      const seen: (string | null)[] = []
      const results = await Promise.allSettled([
        inTenant(db, { orgId: orgA }, async () => seen.push(await context(db))),
        inTenant(db, { orgId: orgB }, async () => seen.push(await context(db))),
      ])
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(refused.reason).toBeInstanceOf(TenantTransactionError)
      expect(seen).toHaveLength(1)
      expect(status(db)).toBe('I')
    })
  })

  it("a tenant call while another transaction's BEGIN is still in flight on the client is refused", async () => {
    await withDb(async (db) => {
      const begin = client(db).query('BEGIN')
      await expect(projects(db, { orgId: orgA }).list()).rejects.toThrow(TenantTransactionError)
      await begin
      await client(db).query('ROLLBACK')
      expect(status(db)).toBe('I')
    })
  })
})

describe('tenant context', () => {
  it('is set inside a tenant call to that tenant only', async () => {
    await withDb(async (db) => {
      expect(await inTenant(db, { orgId: orgA }, () => context(db))).toBe(orgA)
    })
  })

  it('is refused when missing (no organization id), before anything runs', async () => {
    await withDb(async (db) => {
      let ran = false
      await expect(
        inTenant(db, { orgId: '' }, async () => {
          ran = true
        }),
      ).rejects.toThrow(TenantTransactionError)
      expect(ran).toBe(false)
      expect(status(db)).toBe('I')
    })
  })

  it('is absent on a fresh connection, outside any tenant call', async () => {
    await withDb(async (db) => expect(await context(db)).toBeNull())
  })

  it('a failure inside a tenant call writes nothing, leaves the client idle and no tenant context set', async () => {
    const name = `failed-${crypto.randomUUID()}`
    await withDb(async (db) => {
      const failing = inTenant(db, { orgId: orgA }, async (tx) => {
        await tx.insert(schema.project).values({ organizationId: orgA, name, createdBy: creator })
        throw new Error('inner failure')
      })
      await expect(failing).rejects.toThrow('inner failure')
      expect(status(db)).toBe('I')
      expect(await context(db)).toBeNull()
      expect((await projects(db, { orgId: orgA }).list()).some((p) => p.name === name)).toBe(false)
    })
  })

  it("tenant A's call followed by tenant B's on the same client sees only B, and no context remains between them", async () => {
    await withDb(async (db) => {
      const a = await inTenant(db, { orgId: orgA }, () => context(db))
      const between = await context(db)
      const b = await inTenant(db, { orgId: orgB }, () => context(db))
      expect([a, between, b, await context(db)]).toEqual([orgA, null, orgB, null])
    })
  })

  it('100 alternating-tenant requests, 20 at a time, each see only their own context and projects', async () => {
    // 20 at a time: local Postgres caps connections, and other test files run alongside.
    const request = async (i: number) => {
      const orgId = i % 2 ? orgB : orgA
      const { db, close } = await createDb(env.DB.connectionString)
      try {
        const seen = await inTenant(db, { orgId }, () => context(db))
        const rows = await projects(db, { orgId }).list()
        return seen === orgId && rows.length > 0 && rows.every((p) => p.organizationId === orgId)
      } finally {
        await close()
      }
    }
    const results: boolean[] = []
    for (let wave = 0; wave < 5; wave++) {
      results.push(
        ...(await Promise.all(Array.from({ length: 20 }, (_, i) => request(wave * 20 + i)))),
      )
    }
    expect(results).toEqual(Array(100).fill(true))
  })
})

describe('tenant repositories', () => {
  it("a project of tenant A can't be read, updated or deleted through tenant B", async () => {
    await withDb(async (db) => {
      const [p] = await projects(db, { orgId: orgA }).list()
      const asB = projects(db, { orgId: orgB })
      expect(await asB.get(p!.id)).toBeNull()
      expect(await asB.update(p!.id, { name: 'taken' })).toBeNull()
      expect(await asB.remove(p!.id)).toBe(false)
      expect((await projects(db, { orgId: orgA }).get(p!.id))?.name).toBe(p!.name)
    })
  })
})
