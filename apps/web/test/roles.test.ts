import { beforeAll, describe, expect, it } from 'vitest'
import { getTenantContext } from '../src/server/context'
import { authFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { capabilitiesOf, CAPABILITIES, type Capability } from '../src/server/permissions'
import { getTenant, inviteMember } from '../src/modules/organizations/service'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../src/modules/projects/service'
import { authPost, createOrg, expectStatus, joinAs, signUp, type TestUser } from './helpers'

// Phase 2 capability matrix (server/permissions.ts, AGENTS.md invariants 4 and 5): inside the
// caller's own tenant an insufficient role is 403; outside it everything is 404, whatever the role.

type Role = 'owner' | 'admin' | 'member'
const EXPECTED: Record<Role, Capability[]> = {
  owner: [...CAPABILITIES],
  admin: [...CAPABILITIES],
  member: ['project:read', 'project:create', 'project:update'],
}

// Capabilities that act on a project id: another tenant's id must be a 404 before any role check.
const ID_BASED: Capability[] = ['project:read', 'project:update', 'project:delete']

let users: Record<Role, TestUser>
let outsider: TestUser
let orgA: string
let orgB: string
let projectB: { id: string }

beforeAll(async () => {
  const owner = await signUp()
  outsider = await signUp()
  ;[orgA, orgB] = await Promise.all([createOrg(owner, 'roles'), createOrg(outsider, 'other')])
  const [admin, member] = await Promise.all([
    joinAs(owner, orgA, 'admin'),
    joinAs(owner, orgA, 'member'),
  ])
  users = { owner, admin, member }
  projectB = await createProject(outsider.headers, { tenant: orgB, project: { name: 'B' } })
})

/** One call per capability, run as `user` against `tenant` (`id` = a project in that tenant). */
async function attempt(user: TestUser, tenant: string, capability: Capability, id: string) {
  const h = user.headers
  switch (capability) {
    case 'project:read':
      await listProjects(h, { tenant })
      return getProject(h, { tenant, id })
    case 'project:create':
      return createProject(h, { tenant, project: { name: 'created' } })
    case 'project:update':
      return updateProject(h, { tenant, id, project: { name: 'renamed' } })
    case 'project:delete':
      return deleteProject(h, { tenant, id })
    case 'member:invite':
      return inviteMember(h, { tenant, email: `i-${crypto.randomUUID()}@test.local` })
  }
}

describe('capability matrix', () => {
  for (const role of ['owner', 'admin', 'member'] as const) {
    describe(role, () => {
      it('gets exactly its capabilities from getTenant (UI hints)', async () => {
        const t = await getTenant(users[role].headers, { tenant: orgA })
        expect(t).toMatchObject({ role, capabilities: EXPECTED[role] })
      })

      for (const capability of CAPABILITIES) {
        const allowed = EXPECTED[role].includes(capability)
        it(`${allowed ? 'can' : 'cannot (403)'} ${capability} in its own tenant`, async () => {
          const { id } = await createProject(users.owner.headers, {
            tenant: orgA,
            project: { name: `${role}-${capability}` },
          })
          const run = () => attempt(users[role], orgA, capability, id)
          if (allowed) return expect(run()).resolves.toBeDefined()
          await expectStatus(run, 403)
          // Refused means untouched.
          await expect(
            getProject(users.owner.headers, { tenant: orgA, id }),
          ).resolves.toMatchObject({ name: `${role}-${capability}` })
        })

        it(`gets 404 for ${capability} in a foreign tenant`, async () => {
          await expectStatus(() => attempt(users[role], orgB, capability, projectB.id), 404)
        })

        if (ID_BASED.includes(capability))
          it(`gets 404 (not 403) for ${capability} on a foreign project id via its own slug`, async () => {
            await expectStatus(() => attempt(users[role], orgA, capability, projectB.id), 404)
          })
      }
    })
  }

  it('an outsider gets 404 for every capability, never 403', async () => {
    const { id } = await createProject(users.owner.headers, {
      tenant: orgA,
      project: { name: 'target' },
    })
    for (const capability of CAPABILITIES)
      await expectStatus(() => attempt(outsider, orgA, capability, id), 404)
  })
})

// Better Auth's own /api/auth/organization/* endpoints are reachable over HTTP and enforce its
// default roles (ADR-0005 matrix, lower rows). Each test gets a fresh organization.
describe('Better Auth organization endpoints (default roles)', () => {
  async function freshOrg() {
    const owner = await signUp()
    const slug = await createOrg(owner, 'ba')
    const [admin, member] = await Promise.all([
      joinAs(owner, slug, 'admin'),
      joinAs(owner, slug, 'member'),
    ])
    const orgId = (await withDb((db) => getTenantContext(db, owner.headers, slug))).orgId
    return { owner, admin, member, slug, orgId }
  }
  type Org = Awaited<ReturnType<typeof freshOrg>>
  // Read back through Better Auth's own API as the owner (no direct table access).
  const memberId = (o: Org, user: TestUser) =>
    withDb((db) =>
      authFor(db).api.listMembers({ query: { organizationId: o.orgId }, headers: o.owner.headers }),
    ).then((r) => r.members.find((m) => m.userId === user.userId)!.id)
  const invitedEmails = (o: Org) =>
    withDb((db) =>
      authFor(db).api.listInvitations({
        query: { organizationId: o.orgId },
        headers: o.owner.headers,
      }),
    ).then((list) => list.map((i) => i.email))
  const roleIn = (slug: string, user: TestUser) =>
    withDb((db) => getTenantContext(db, user.headers, slug)).then((c) => c.role)
  const post = (as: TestUser, path: string, body: unknown) =>
    authPost(`/organization/${path}`, body, undefined, as)

  it('only the owner can delete the organization', async () => {
    const o = await freshOrg()
    for (const role of ['admin', 'member'] as const)
      expect((await post(o[role], 'delete', { organizationId: o.orgId })).status).toBe(403)
    await expect(roleIn(o.slug, o.owner)).resolves.toBe('owner')
    expect((await post(o.owner, 'delete', { organizationId: o.orgId })).status).toBe(200)
    await expectStatus(() => withDb((db) => getTenantContext(db, o.owner.headers, o.slug)), 404)
  })

  it('a member can invite nobody, update nothing and remove nobody', async () => {
    const o = await freshOrg()
    const email = `x-${crypto.randomUUID()}@test.local`
    const attempts = [
      post(o.member, 'invite-member', { email, role: 'member', organizationId: o.orgId }),
      post(o.member, 'update', { data: { name: 'pwned' }, organizationId: o.orgId }),
      post(o.member, 'remove-member', { memberIdOrEmail: o.admin.email, organizationId: o.orgId }),
      post(o.member, 'update-member-role', {
        memberId: await memberId(o, o.member),
        role: 'admin',
        organizationId: o.orgId,
      }),
    ]
    for (const res of await Promise.all(attempts)) expect(res.ok).toBe(false)
    await expect(invitedEmails(o)).resolves.not.toContain(email)
    await expect(getTenant(o.owner.headers, { tenant: o.slug })).resolves.toMatchObject({
      name: o.slug,
    })
    await expect(roleIn(o.slug, o.admin)).resolves.toBe('admin')
    await expect(roleIn(o.slug, o.member)).resolves.toBe('member')
  })

  it('an admin cannot reach or touch the owner role', async () => {
    const o = await freshOrg()
    const email = `x-${crypto.randomUUID()}@test.local`
    const ownerId = await memberId(o, o.owner)
    const attempts = [
      post(o.admin, 'invite-member', { email, role: 'owner', organizationId: o.orgId }),
      post(o.admin, 'update-member-role', {
        memberId: await memberId(o, o.member),
        role: 'owner',
        organizationId: o.orgId,
      }),
      post(o.admin, 'update-member-role', {
        memberId: await memberId(o, o.admin),
        role: 'owner',
        organizationId: o.orgId,
      }),
      post(o.admin, 'update-member-role', {
        memberId: ownerId,
        role: 'member',
        organizationId: o.orgId,
      }),
      post(o.admin, 'remove-member', { memberIdOrEmail: ownerId, organizationId: o.orgId }),
    ]
    for (const res of await Promise.all(attempts)) expect(res.ok).toBe(false)
    await expect(invitedEmails(o)).resolves.not.toContain(email)
    await expect(roleIn(o.slug, o.owner)).resolves.toBe('owner')
    await expect(roleIn(o.slug, o.admin)).resolves.toBe('admin')
    await expect(roleIn(o.slug, o.member)).resolves.toBe('member')
  })

  it('an admin can update the organization and manage non-owner members (accepted default)', async () => {
    const o = await freshOrg()
    const renamed = await post(o.admin, 'update', {
      data: { name: 'Renamed' },
      organizationId: o.orgId,
    })
    expect(renamed.status).toBe(200)
    const email = `x-${crypto.randomUUID()}@test.local`
    const invited = await post(o.admin, 'invite-member', {
      email,
      role: 'member',
      organizationId: o.orgId,
    })
    expect(invited.status).toBe(200)
    await expect(invitedEmails(o)).resolves.toContain(email)
    const promoted = await post(o.admin, 'update-member-role', {
      memberId: await memberId(o, o.member),
      role: 'admin',
      organizationId: o.orgId,
    })
    expect(promoted.status).toBe(200)
    await expect(roleIn(o.slug, o.member)).resolves.toBe('admin')
    const removed = await post(o.admin, 'remove-member', {
      memberIdOrEmail: o.member.email,
      organizationId: o.orgId,
    })
    expect(removed.status).toBe(200)
    await expectStatus(() => roleIn(o.slug, o.member), 404)
  })
})

describe('capabilitiesOf', () => {
  it('unions comma-separated roles and ignores whitespace', () => {
    expect(capabilitiesOf('member, admin')).toEqual(EXPECTED.admin)
  })

  it('grants nothing to unknown or empty roles (fail closed)', () => {
    expect(capabilitiesOf('superuser')).toEqual([])
    expect(capabilitiesOf('')).toEqual([])
    expect(capabilitiesOf('__proto__')).toEqual([])
    expect(capabilitiesOf('toString')).toEqual([])
  })
})
