import { createAuth } from '@saas-foundation/auth'
import { billing, createDb, findOrganizationBySlug, type Db } from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isLive } from '../src/modules/billing/policy'
import { inviteMember } from '../src/modules/organizations/service'
import { createProject } from '../src/modules/projects/service'
import { authFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { createOrg, joinAs, randomIp, signUp, type TestUser } from './helpers'
import { testBotProtection } from './turnstile-fake'

// Deleting an organization is one database transaction: Better Auth's adapter deletes its members,
// invitations and the organization (projects and the billing record follow by FK cascade), and a
// database error part-way rolls all of it back. Failures are injected by a test-only trigger that
// the owner installs for marked organization ids only; requests go through Better Auth's real HTTP
// handler, as the runtime role (like production after ADR-0038) and as the owner (production today).

// The local owner (docker-compose's known credentials, as in global-setup.ts); test-only.
const OWNER_URL = 'postgres://app:app@localhost:5432/app_test'

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
const clientOf = (db: Db) => (rawDb(db) as unknown as { $client: { query: Query } }).$client

/** One query on its own owner connection: independent of the request's connection. */
async function asOwner(sql: string, params: unknown[] = []) {
  const { db, close } = await createDb(OWNER_URL)
  try {
    return await clientOf(db).query(sql, params)
  } finally {
    await close()
  }
}

/** Runs `fn` with a request connection as the runtime role (Hyperdrive binding) or the owner. */
type Connect = <T>(fn: (db: Db) => Promise<T>) => Promise<T>
const asRuntime: Connect = withDb
const asOwnerRole: Connect = async (fn) => {
  const { db, close } = await createDb(OWNER_URL)
  try {
    return await fn(db)
  } finally {
    await close()
  }
}

const request = (path: string, as: TestUser, body: unknown) =>
  new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env.BETTER_AUTH_URL,
      'cf-connecting-ip': randomIp(),
      cookie: as.headers.get('cookie')!,
    },
    body: JSON.stringify(body),
  })

/** The app's own Better Auth (`authFor`) deleting `orgId` as `as`, on the given connection. */
const deleteOrg = (connect: Connect, as: TestUser, orgId: string) =>
  connect((db) =>
    authFor(db).handler(request('/organization/delete', as, { organizationId: orgId })),
  )

type Call = [string, string, string | undefined]
/** A fake Polar member sync (ADR-0022): records calls, optionally fails `removeAccount`. */
function fakeMembers(failRemove = false) {
  const calls: Call[] = []
  const step =
    (name: string, fail = false) =>
    async (orgId: string, userId?: string) => {
      calls.push([name, orgId, userId])
      if (fail) throw new Error(`${name} failed`)
    }
  return {
    calls,
    members: {
      revoke: step('revoke'),
      grant: step('grant'),
      removeAccount: step('removeAccount', failRemove),
    },
  }
}

/** Like `deleteOrg`, with the app's billing rules and a fake Polar member sync. */
const deleteOrgWithPolar = (
  as: TestUser,
  orgId: string,
  members: ReturnType<typeof fakeMembers>['members'],
) =>
  withDb((db) =>
    createAuth({
      db,
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      allowSignUp: () => true,
      requireEmailVerification: true,
      botProtection: testBotProtection,
      sendEmail: async () => {},
      billing: {
        memberLimit: async () => null,
        blocksDeletion: async (id) => isLive(await billing(db, { orgId: id }).subscription()),
        members,
      },
    }).handler(request('/organization/delete', as, { organizationId: orgId })),
  )

/**
 * An organization with an owner, an admin (joined through an accepted invitation), a pending
 * invitation, two projects and a billing record whose subscription ended (deletion allowed).
 */
async function populatedOrg() {
  const owner = await signUp()
  const slug = await createOrg(owner, 'del')
  await joinAs(owner, slug, 'admin')
  await inviteMember(owner.headers, {
    tenant: slug,
    email: `p-${crypto.randomUUID()}@test.local`,
    role: 'member',
  })
  for (const name of ['one', 'two'])
    await createProject(owner.headers, { tenant: slug, project: { name } })
  const orgId = (await withDb((db) => findOrganizationBySlug(db, slug)))!.id
  await setSubscription(orgId, 'canceled')
  return { owner, orgId }
}

const setSubscription = (orgId: string, status: 'active' | 'canceled') =>
  asOwner(
    `INSERT INTO billing_subscription (organization_id, provider, provider_customer_id,
         provider_subscription_id, plan_key, status, provider_event_at)
       VALUES ($1, 'test', $2, $3, 'pro', $4, now())
       ON CONFLICT (organization_id) DO UPDATE SET status = $4`,
    [orgId, `cus_del_${orgId}`, `sub_del_${orgId}`, status],
  )

/** Row counts for the organization, read on an independent owner connection. */
async function rowsOf(orgId: string) {
  const { rows } = await asOwner(
    `SELECT (SELECT count(*) FROM organization WHERE id = $1)::int AS organization,
            (SELECT count(*) FROM member WHERE organization_id = $1)::int AS member,
            (SELECT count(*) FROM invitation WHERE organization_id = $1)::int AS invitation,
            (SELECT count(*) FROM project WHERE organization_id = $1)::int AS project,
            (SELECT count(*) FROM billing_subscription WHERE organization_id = $1)::int AS billing`,
    [orgId],
  )
  return rows[0]
}
const WHOLE = { organization: 1, member: 2, invitation: 2, project: 2, billing: 1 }
const GONE = { organization: 0, member: 0, invitation: 0, project: 0, billing: 0 }

/** Makes the next deletes from `table` fail for this organization (test-only trigger). */
const failDeleteAt = (orgId: string, table: 'invitation' | 'organization') =>
  asOwner('INSERT INTO test_delete_fault (organization_id, at_table) VALUES ($1, $2)', [
    orgId,
    table,
  ])
const clearFaults = (orgId: string) =>
  asOwner('DELETE FROM test_delete_fault WHERE organization_id = $1', [orgId])

beforeAll(async () => {
  // Owner-only objects; the trigger function runs as its owner, so the runtime role needs no grant.
  await asOwner(`
    CREATE TABLE IF NOT EXISTS test_delete_fault (
      organization_id text NOT NULL, at_table text NOT NULL, PRIMARY KEY (organization_id, at_table));
    CREATE OR REPLACE FUNCTION test_delete_fault() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.test_delete_fault f WHERE f.at_table = TG_TABLE_NAME
                   AND f.organization_id = coalesce(to_jsonb(OLD)->>'organization_id', to_jsonb(OLD)->>'id'))
      THEN RAISE EXCEPTION 'test fault: delete from % refused', TG_TABLE_NAME;
      END IF;
      RETURN OLD;
    END $$;
    REVOKE ALL ON FUNCTION test_delete_fault() FROM PUBLIC;
    DROP TRIGGER IF EXISTS test_delete_fault ON invitation;
    CREATE TRIGGER test_delete_fault BEFORE DELETE ON invitation
      FOR EACH ROW EXECUTE FUNCTION test_delete_fault();
    DROP TRIGGER IF EXISTS test_delete_fault ON organization;
    CREATE TRIGGER test_delete_fault BEFORE DELETE ON organization
      FOR EACH ROW EXECUTE FUNCTION test_delete_fault();`)
})

afterAll(async () => {
  await asOwner(`
    DROP TRIGGER IF EXISTS test_delete_fault ON invitation;
    DROP TRIGGER IF EXISTS test_delete_fault ON organization;
    DROP FUNCTION IF EXISTS test_delete_fault();
    DROP TABLE IF EXISTS test_delete_fault;`)
})

describe.each([
  ['the runtime role', asRuntime],
  ['the owner', asOwnerRole],
])('organization deletion as %s is atomic', (_label, connect) => {
  it('an owner deletes the organization with its members, invitations, projects and billing record', async () => {
    const { owner, orgId } = await populatedOrg()
    expect(await rowsOf(orgId)).toEqual(WHOLE)
    expect((await deleteOrg(connect, owner, orgId)).status).toBe(200)
    expect(await rowsOf(orgId)).toEqual(GONE)
  })

  for (const table of ['invitation', 'organization'] as const)
    it(`a database failure at the ${table} delete, after the member delete ran, leaves everything in place`, async () => {
      const { owner, orgId } = await populatedOrg()
      await failDeleteAt(orgId, table)
      const res = await deleteOrg(connect, owner, orgId)
      expect(res.ok).toBe(false)
      expect(await rowsOf(orgId)).toEqual(WHOLE)
      // Once the fault is gone, the same request deletes everything.
      await clearFaults(orgId)
      expect((await deleteOrg(connect, owner, orgId)).status).toBe(200)
      expect(await rowsOf(orgId)).toEqual(GONE)
    })
})

describe('organization deletion and the Polar member sync (ADR-0022)', () => {
  it('a live subscription refuses the deletion before Polar is called', async () => {
    const { owner, orgId } = await populatedOrg()
    await setSubscription(orgId, 'active')
    const sync = fakeMembers()
    expect((await deleteOrgWithPolar(owner, orgId, sync.members)).status).toBe(409)
    expect(sync.calls).toEqual([])
    expect(await rowsOf(orgId)).toEqual(WHOLE)
  })

  it('a failed Polar removal deletes nothing', async () => {
    const { owner, orgId } = await populatedOrg()
    const sync = fakeMembers(true)
    expect((await deleteOrgWithPolar(owner, orgId, sync.members)).status).toBe(503)
    expect(sync.calls).toEqual([['removeAccount', orgId, undefined]])
    expect(await rowsOf(orgId)).toEqual(WHOLE)
  })

  it('a database failure after a successful Polar removal restores the database, not Polar; a retry removes again and completes', async () => {
    const { owner, orgId } = await populatedOrg()
    await failDeleteAt(orgId, 'organization')
    const sync = fakeMembers()
    expect((await deleteOrgWithPolar(owner, orgId, sync.members)).ok).toBe(false)
    expect(await rowsOf(orgId)).toEqual(WHOLE)
    // The external side effect already happened; a SQL rollback can't undo it.
    expect(sync.calls).toEqual([['removeAccount', orgId, undefined]])

    await clearFaults(orgId)
    expect((await deleteOrgWithPolar(owner, orgId, sync.members)).status).toBe(200)
    expect(sync.calls).toEqual([
      ['removeAccount', orgId, undefined],
      ['removeAccount', orgId, undefined],
    ])
    expect(await rowsOf(orgId)).toEqual(GONE)
  })
})

it('concurrent deletions of one organization leave it fully deleted and never half-deleted', async () => {
  const { owner, orgId } = await populatedOrg()
  const results = await Promise.all([1, 2, 3].map(() => deleteOrg(asRuntime, owner, orgId)))
  const statuses = results.map((r) => r.status)
  expect(statuses).toContain(200)
  expect(statuses.every((s) => s < 500)).toBe(true)
  expect(await rowsOf(orgId)).toEqual(GONE)
})
