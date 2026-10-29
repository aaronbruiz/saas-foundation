import { beforeAll, describe, expect, it } from 'vitest'
import { billing, createDb, findOrganizationBySlug, projects, type Db } from '@saas-foundation/db'
import { inTenant, rawDb, schema, TenantTransactionError } from '@saas-foundation/db/internal'
import { env } from 'cloudflare:workers'
import { authFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { createProject } from '../src/modules/projects/service'
import { createOrg, PASSWORD, randomIp, signUp } from './helpers'
import { captchaHeader } from './turnstile-fake'

// ADR-0040 phase 1: every tenant-scoped repository call runs in its own transaction with the
// tenant set transaction-locally, refuses to start while the client is already in one, and owns
// the connection until it ends: nothing outside it can run a statement on that client meanwhile.

let orgA: string
let orgB: string
let creator: string

const orgId = async (slug: string) => (await withDb((db) => findOrganizationBySlug(db, slug)))!.id

// Direct SQL for assertions only (apps/app doesn't depend on drizzle-orm).
type Client = {
  query: ((sql: string) => Promise<{ rows: { v: string | null }[] }>) &
    ((sql: string, cb: (err: Error | null) => void) => void)
  getTransactionStatus: () => string | null
  /** pg's own flag: false while a statement is in flight. */
  readyForQuery: boolean
  on: (event: 'error', listener: (err: Error) => void) => void
}
const client = (db: Db) => (rawDb(db) as unknown as { $client: Client }).$client

/**
 * The tenant context the next statement on this client sees (null when none). Inside a tenant
 * call it runs on the same connection, so it reads that transaction's setting.
 */
const context = async (db: Db) =>
  (await client(db).query(`select current_setting('app.org_id', true) as v`)).rows[0]!.v || null

const status = (db: Db) => client(db).getTransactionStatus()

/** A refusal by the guard, directly or wrapped by Drizzle's query error. */
const isRefusal = (e: unknown) =>
  e instanceof TenantTransactionError ||
  (e as { cause?: unknown } | null)?.cause instanceof TenantTransactionError

async function expectRefused(attempt: Promise<unknown> | (() => Promise<unknown>), what?: string) {
  const error = await (typeof attempt === 'function' ? attempt() : attempt).then(
    () => new Error(`${what ?? 'attempt'} was not refused`),
    (e: unknown) => e,
  )
  expect(isRefusal(error), `${what ?? ''} ${String(error)}`).toBe(true)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const names = async (db: Db, orgId: string) =>
  (await projects(db, { orgId }).list()).map((p) => p.name)

/**
 * Starts a tenant transaction for `orgId` that inserts a project named `name`, then waits at a
 * barrier: `inside` resolves once it holds the connection mid-transaction; `finish(ok)` lets it
 * commit (ok) or fail. The test body stays outside its async context, like another caller.
 */
async function heldTenantTransaction(db: Db, orgId: string, name: string) {
  const inside = deferred()
  const proceed = deferred()
  let ok = false
  const done = inTenant(db, { orgId }, async (tx) => {
    await tx.insert(schema.project).values({ organizationId: orgId, name, createdBy: creator })
    inside.resolve()
    await proceed.promise
    if (!ok) throw new Error('tenant failure')
  })
  await inside.promise
  return {
    done,
    finish: (commit: boolean) => {
      ok = commit
      proceed.resolve()
      return done
    },
  }
}

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
        await expectRefused(billing(db, { orgId: orgA }).subscription())
        await expectRefused(projects(db, { orgId: orgA }).list())
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
        await expectRefused(inTenant(db, { orgId: orgB }, async () => null))
        await expectRefused(projects(db, { orgId: orgB }).count())
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
      expect(isRefusal(refused.reason)).toBe(true)
      expect(seen).toHaveLength(1)
      expect(status(db)).toBe('I')
    })
  })

  it("a tenant call while another transaction's BEGIN is still in flight on the client is refused", async () => {
    await withDb(async (db) => {
      const begin = client(db).query('BEGIN')
      await expectRefused(projects(db, { orgId: orgA }).list())
      await begin
      await client(db).query('ROLLBACK')
      expect(status(db)).toBe('I')
    })
  })
})

describe('a tenant transaction owns its connection until it ends', () => {
  it('a raw transaction started during it is refused before BEGIN is sent, and the tenant transaction still rolls back', async () => {
    const name = `held-${crypto.randomUUID()}`
    const rawName = `raw-${crypto.randomUUID()}`
    await withDb(async (db) => {
      const held = await heldTenantTransaction(db, orgA, name)
      const raw = rawDb(db).transaction(async (tx) => {
        await tx
          .insert(schema.project)
          .values({ organizationId: orgA, name: rawName, createdBy: creator })
      })
      await expectRefused(raw)
      await expect(held.finish(false)).rejects.toThrow('tenant failure')
      expect(status(db)).toBe('I')
      const left = await names(db, orgA)
      expect(left).not.toContain(name)
      expect(left).not.toContain(rawName)
    })
  })

  it('a raw transaction started during it is refused, and the tenant transaction commits exactly its own work', async () => {
    const name = `held-${crypto.randomUUID()}`
    await withDb(async (db) => {
      const held = await heldTenantTransaction(db, orgA, name)
      await expectRefused(rawDb(db).transaction(async () => 'raw'))
      await held.finish(true)
      expect((await names(db, orgA)).filter((n) => n === name)).toHaveLength(1)
    })
  })

  it('raw COMMIT, ROLLBACK and plain statements from outside are refused while it runs', async () => {
    await withDb(async (db) => {
      const held = await heldTenantTransaction(db, orgA, `held-${crypto.randomUUID()}`)
      for (const statement of ['COMMIT', 'ROLLBACK', 'select 1']) {
        await expectRefused(async () => client(db).query(statement))
      }
      await expect(held.finish(false)).rejects.toThrow('tenant failure')
      expect(await projects(db, { orgId: orgA }).count()).toBeGreaterThan(0)
    })
  })

  it('a Better Auth sign-up on the same connection during it fails without touching the tenant transaction', async () => {
    const name = `held-${crypto.randomUUID()}`
    const email = `u-${crypto.randomUUID()}@test.local`
    await withDb(async (db) => {
      const held = await heldTenantTransaction(db, orgA, name)
      const outcome = await authFor(db)
        .handler(
          new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-up/email`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: env.BETTER_AUTH_URL,
              'cf-connecting-ip': randomIp(),
              ...captchaHeader,
            },
            body: JSON.stringify({ email, password: PASSWORD, name: email }),
          }),
        )
        .then(
          (res) => (res.ok ? 'signed up' : 'failed'),
          (e: unknown) => (isRefusal(e) ? 'refused' : e),
        )
      expect(['failed', 'refused']).toContain(outcome)
      await expect(held.finish(false)).rejects.toThrow('tenant failure')
      expect(await names(db, orgA)).not.toContain(name)
      const { rows } = await client(db).query(
        `select count(*)::int as v from "user" where email = '${email}'`,
      )
      expect(Number(rows[0]!.v)).toBe(0)
    })
  })

  it('a raw transaction and a tenant call started together: exactly one runs, the other is refused, and the connection recovers', async () => {
    await withDb(async (db) => {
      const results = await Promise.allSettled([
        rawDb(db).transaction(async (tx) => tx.select().from(schema.project).limit(1)),
        projects(db, { orgId: orgA }).list(),
      ])
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(isRefusal(refused.reason)).toBe(true)
      expect(status(db)).toBe('I')
      expect(await projects(db, { orgId: orgA }).count()).toBeGreaterThan(0)
    })
  })

  it('a tenant call while a raw transaction is open is refused; once it ends, tenant calls work', async () => {
    await withDb(async (db) => {
      await client(db).query('BEGIN')
      await expectRefused(projects(db, { orgId: orgA }).list())
      await client(db).query('ROLLBACK')
      expect(await projects(db, { orgId: orgA }).count()).toBeGreaterThan(0)
    })
  })

  it('a tenant call between a failed statement and the server reporting ready is refused', async () => {
    await withDb(async (db) => {
      // One message: BEGIN, then an error. pg runs the callback on the ErrorResponse, while its cached
      // status still says idle ('I'); only ReadyForQuery (status 'E') follows.
      const seen = await new Promise<{ status: string | null; attempt: Promise<unknown> }>(
        (resolve) =>
          client(db).query('BEGIN; select 1/0', () =>
            resolve({ status: status(db), attempt: projects(db, { orgId: orgA }).list() }),
          ),
      )
      expect(seen.status).toBe('I')
      await expectRefused(seen.attempt)
      await client(db).query('ROLLBACK')
      expect(await projects(db, { orgId: orgA }).count()).toBeGreaterThan(0)
    })
  })

  it('inside it, statements that would end it, nest it or change its tenant are refused, and the tenant stays set', async () => {
    const refused = [
      'COMMIT',
      'end',
      'ROLLBACK',
      'abort',
      'BEGIN',
      'start transaction',
      'SAVEPOINT s',
      'release savepoint s',
      'prepare transaction $$x$$',
      // eslint-disable-next-line no-restricted-syntax -- the runtime guard is what's under test
      "select set_config('app.org_id', 'other', false)",
      // eslint-disable-next-line no-restricted-syntax -- the runtime guard is what's under test
      "SET app.org_id = 'other'",
      // eslint-disable-next-line no-restricted-syntax -- the runtime guard is what's under test
      "set local app.org_id to 'other'",
      'reset all',
      'discard all',
      'select 1; commit',
      '/* hidden */ commit',
      '-- hidden\ncommit',
    ]
    await withDb(async (db) => {
      const seen = await inTenant(db, { orgId: orgA }, async (tx) => {
        for (const statement of refused) {
          await expectRefused(async () => client(db).query(statement), statement)
        }
        await expectRefused(tx.transaction(async () => null))
        await expectRefused(rawDb(db).transaction(async () => null))
        return context(db)
      })
      expect(seen).toBe(orgA)
      expect(status(db)).toBe('I')
      expect(await context(db)).toBeNull()
    })
  })

  for (const outcome of ['commits', 'fails'] as const) {
    it(`work resumed inside its body after the body ${outcome === 'commits' ? 'returned' : 'threw'} is refused, and never runs after ${outcome === 'commits' ? 'COMMIT' : 'ROLLBACK'}`, async () => {
      const name = `late-${crypto.randomUUID()}`
      await withDb(async (db) => {
        let late!: Promise<unknown> // settles with the insert's error, or 'ran'
        let duringEnd: { status: string | null; inFlight: boolean } | undefined
        const done = inTenant(db, { orgId: orgA }, async (tx) => {
          late = (async () => {
            // Microtasks run in a fixed order, and no server response can arrive between them: poll
            // until the body has settled and COMMIT or ROLLBACK is on the wire, then try to write.
            for (let i = 0; i < 1000 && client(db).readyForQuery; i++) await null
            duringEnd = { status: status(db), inFlight: !client(db).readyForQuery }
            return tx
              .insert(schema.project)
              .values({ organizationId: orgA, name, createdBy: creator })
          })().then(
            () => 'ran',
            (e: unknown) => e,
          )
          if (outcome === 'fails') throw new Error('body failure')
        })
        if (outcome === 'commits') await done
        else await expect(done).rejects.toThrow('body failure')
        expect(isRefusal(await late)).toBe(true)
        expect(duringEnd).toEqual({ status: 'T', inFlight: true })
        expect(status(db)).toBe('I')
        expect(await names(db, orgA)).not.toContain(name)
      })
    })
  }

  it('a statement still running when the body returns fails the transaction closed: nothing commits', async () => {
    const name = `pending-${crypto.randomUUID()}`
    await withDb(async (db) => {
      let pending!: Promise<unknown>
      const done = inTenant(db, { orgId: orgA }, async (tx) => {
        await tx.insert(schema.project).values({ organizationId: orgA, name, createdBy: creator })
        pending = client(db).query('select pg_sleep(0.05)')
      })
      await expectRefused(done)
      await pending
      expect(status(db)).toBe('I')
      expect(await names(db, orgA)).not.toContain(name)
      expect(await projects(db, { orgId: orgA }).count()).toBeGreaterThan(0)
    })
  })

  it('work admitted just before the body returns runs inside the transaction and fails it closed', async () => {
    const name = `racing-${crypto.randomUUID()}`
    await withDb(async (db) => {
      let racing!: Promise<unknown>
      const done = inTenant(db, { orgId: orgA }, async (tx) => {
        const go = deferred()
        racing = (async () => {
          await go.promise
          return tx
            .insert(schema.project)
            .values({ organizationId: orgA, name, createdBy: creator })
        })()
        go.resolve() // the insert is admitted in a microtask that runs before the body settles
      })
      await expectRefused(done)
      await racing
      expect(status(db)).toBe('I')
      expect(await names(db, orgA)).not.toContain(name)
    })
  })

  it('a COMMIT hidden in nested comments is refused, and the transaction still rolls back', async () => {
    const name = `nested-${crypto.randomUUID()}`
    await withDb(async (db) => {
      const done = inTenant(db, { orgId: orgA }, async (tx) => {
        await tx.insert(schema.project).values({ organizationId: orgA, name, createdBy: creator })
        await expectRefused(async () => client(db).query('/* a /* b */ c */ COMMIT'))
        throw new Error('body failure')
      })
      await expect(done).rejects.toThrow('body failure')
      expect(await names(db, orgA)).not.toContain(name)
    })
  })

  it('a tenant setter spelled with Unicode escapes is refused inside, and the tenant stays set', async () => {
    await withDb(async (db) => {
      const seen = await inTenant(db, { orgId: orgA }, async () => {
        await expectRefused(async () =>
          client(db).query(`select pg_catalog.U&"s\\0065t_config"('app.org_id', 'other', false)`),
        )
        await expectRefused(async () =>
          // eslint-disable-next-line no-restricted-syntax -- the runtime guard is what's under test
          client(db).query(`update pg_settings set setting = 'other' where name = 'app.org_id'`),
        )
        return context(db)
      })
      expect(seen).toBe(orgA)
      expect(await context(db)).toBeNull()
    })
  })

  it('a session-level tenant setting left on the connection by other code never reaches a tenant transaction', async () => {
    await withDb(async (db) => {
      // Outside a tenant transaction the text checks are best effort; this spelling passes them.
      await client(db).query(`SET app /* x */ .org_id = 'forged'`)
      expect(await context(db)).toBe('forged')
      expect(await inTenant(db, { orgId: orgA }, () => context(db))).toBe(orgA)
      expect(await inTenant(db, { orgId: orgB }, () => context(db))).toBe(orgB)
    })
  })

  it('a callback left behind by a finished tenant transaction cannot use the connection', async () => {
    await withDb(async (db) => {
      const later = deferred()
      let stale!: Promise<unknown>
      await inTenant(db, { orgId: orgA }, async () => {
        stale = (async () => {
          await later.promise
          return client(db).query('select 1')
        })()
      })
      later.resolve()
      await expectRefused(stale)
      expect(await projects(db, { orgId: orgA }).count()).toBeGreaterThan(0)
    })
  })

  it('a connection lost mid-transaction commits nothing and refuses further tenant calls', async () => {
    const name = `lost-${crypto.randomUUID()}`
    await withDb(async (db) => {
      client(db).on('error', () => {})
      const lost = inTenant(db, { orgId: orgA }, async (tx) => {
        await tx.insert(schema.project).values({ organizationId: orgA, name, createdBy: creator })
        await client(db).query('select pg_terminate_backend(pg_backend_pid())')
      })
      await expect(lost).rejects.toThrow()
      await expect(projects(db, { orgId: orgA }).list()).rejects.toThrow()
    })
    expect(await withDb((db) => names(db, orgA))).not.toContain(name)
  })

  it('a write reported as timed out commits nothing, even when the tenant call catches the timeout', async () => {
    const name = `timed-out-${crypto.randomUUID()}`
    await withDb(async (db) => {
      const caught = inTenant(db, { orgId: orgA }, async () => {
        const slow = (client(db).query as (sql: string, values: unknown[]) => Promise<unknown>)(
          `insert into project (id, organization_id, name, created_by) select gen_random_uuid()::text, $1, $2, $3 from pg_sleep(6)`,
          [orgA, name, creator],
        )
        await expect(slow).rejects.toThrow('Query read timeout')
        // The statement still runs on the server; wait for it to finish before ending the call.
        while (!client(db).readyForQuery) await new Promise((r) => setTimeout(r, 50))
      })
      await expect(caught).rejects.toThrow(TenantTransactionError)
    })
    expect(await withDb((db) => names(db, orgA))).not.toContain(name)
  }, 15_000)

  it('inside it, statements answered through a callback instead of a promise are refused', async () => {
    await withDb(async (db) => {
      const query = client(db).query.bind(client(db)) as (...args: unknown[]) => unknown
      await inTenant(db, { orgId: orgA }, async () => {
        expect(() => query('select 1', () => {})).toThrow(TenantTransactionError)
        expect(() => query('select 1', [], () => {})).toThrow(TenantTransactionError)
        expect(() => query({ text: 'select 1', callback: () => {} })).toThrow(
          TenantTransactionError,
        )
        expect(() => query({ text: 'select 1', submit: () => {} })).toThrow(TenantTransactionError)
      })
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
      await expectRefused(
        inTenant(db, { orgId: '' }, async () => {
          ran = true
        }),
      )
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

describe('round trips (ADR-0040 decision 8)', () => {
  it('creating a project reads the plan and inserts in one tenant transaction', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'rt')
    // Every BEGIN the guard sends goes through pg's own Client.prototype.query.
    const base = await withDb(async (db) =>
      Object.getPrototypeOf(Object.getPrototypeOf(client(db))),
    )
    const original = base.query
    let begins = 0
    base.query = function (this: unknown, ...args: unknown[]) {
      if (args[0] === 'BEGIN') begins++
      return original.apply(this, args)
    }
    try {
      await createProject(owner.headers, { tenant: slug, project: { name: 'one' } })
    } finally {
      base.query = original
    }
    expect(begins).toBe(1)
  })
})
