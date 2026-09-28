import { beforeAll, describe, expect, it } from 'vitest'
import { getTenantContext } from '../src/server/context'
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
  member: ['project:read', 'project:create', 'project:update', 'project:delete'],
}

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
          if (allowed) await expect(run()).resolves.toBeDefined()
          else await expectStatus(run, 403)
        })

        it(`gets 404 for ${capability} in a foreign tenant`, async () => {
          await expectStatus(() => attempt(users[role], orgB, capability, projectB.id), 404)
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

describe('Better Auth organization endpoints agree with the matrix', () => {
  it('only the owner can delete the organization', async () => {
    const orgId = (await withDb((db) => getTenantContext(db, users.owner.headers, orgA))).orgId
    for (const role of ['admin', 'member'] as const) {
      const res = await authPost(
        '/organization/delete',
        { organizationId: orgId },
        undefined,
        users[role],
      )
      expect(res.status).toBe(403)
    }
    await expect(
      withDb((db) => getTenantContext(db, users.owner.headers, orgA)),
    ).resolves.toMatchObject({ role: 'owner' })
  })

  it('a member cannot invite through the Better Auth API either', async () => {
    const orgId = (await withDb((db) => getTenantContext(db, users.owner.headers, orgA))).orgId
    const res = await authPost(
      '/organization/invite-member',
      { email: `x-${crypto.randomUUID()}@test.local`, role: 'member', organizationId: orgId },
      undefined,
      users.member,
    )
    expect(res.status).toBe(403)
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
