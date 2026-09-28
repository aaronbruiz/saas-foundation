import { beforeAll, describe, expect, it } from 'vitest'
import { getTenantContext } from '../src/server/context'
import { withDb } from '../src/server/db'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../src/modules/projects/service'
import { acceptInvitation, inviteMember } from '../src/modules/organizations/service'
import { createOrg, expectStatus, signUp, type TestUser } from './helpers'

// Vertical Slice 001 acceptance (spec §8/§11, AGENTS.md invariants 1, 2, 5, 9).
// Alice owns org A with a project; Bob owns org B. Nothing Bob does may reach A's data.

let alice: TestUser
let bob: TestUser
let orgA: string
let orgB: string
let projectA: { id: string; name: string }

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([signUp(), signUp()])
  ;[orgA, orgB] = await Promise.all([createOrg(alice, 'a'), createOrg(bob, 'b')])
  projectA = await createProject(alice.headers, { tenant: orgA, project: { name: 'Alpha' } })
})

describe('getTenantContext', () => {
  it('resolves an owner of the tenant', async () => {
    const ctx = await withDb((db) => getTenantContext(db, alice.headers, orgA))
    expect(ctx).toMatchObject({ userId: alice.userId, slug: orgA, role: 'owner' })
  })

  it('rejects a request without a session (401)', async () => {
    await expectStatus(() => withDb((db) => getTenantContext(db, new Headers(), orgA)), 401)
  })

  it('returns 404 for an unknown or malformed slug', async () => {
    await expectStatus(
      () => withDb((db) => getTenantContext(db, alice.headers, 'no-such-org-x1')),
      404,
    )
    await expectStatus(() => withDb((db) => getTenantContext(db, alice.headers, 'NOT A SLUG')), 404)
  })

  it('returns 404 (not 403) for a non-member', async () => {
    await expectStatus(() => withDb((db) => getTenantContext(db, bob.headers, orgA)), 404)
  })
})

describe('projects: own tenant', () => {
  it('creates with createdBy from the session and lists only the tenant', async () => {
    const p = await createProject(bob.headers, { tenant: orgB, project: { name: 'Bravo' } })
    expect(p).toMatchObject({ name: 'Bravo', createdBy: bob.userId })
    const names = (await listProjects(bob.headers, { tenant: orgB })).map((x) => x.name)
    expect(names).toEqual(['Bravo'])
    expect(names).not.toContain('Alpha')
  })

  it('gets, updates and deletes within the tenant', async () => {
    const p = await createProject(alice.headers, { tenant: orgA, project: { name: 'Temp' } })
    await expect(getProject(alice.headers, { tenant: orgA, id: p.id })).resolves.toMatchObject({
      name: 'Temp',
    })
    await expect(
      updateProject(alice.headers, { tenant: orgA, id: p.id, project: { name: 'Temp 2' } }),
    ).resolves.toMatchObject({ name: 'Temp 2' })
    await expect(deleteProject(alice.headers, { tenant: orgA, id: p.id })).resolves.toEqual({
      id: p.id,
    })
    await expectStatus(() => getProject(alice.headers, { tenant: orgA, id: p.id }), 404)
  })
})

describe('cross-tenant matrix: Bob vs org A', () => {
  const viaForeignSlug = () => ({ tenant: orgA, id: projectA.id })
  const viaOwnSlug = () => ({ tenant: orgB, id: projectA.id })

  it('cannot list org A', async () => {
    await expectStatus(() => listProjects(bob.headers, { tenant: orgA }), 404)
  })

  for (const [label, ref] of [
    ['foreign slug', viaForeignSlug],
    ['own slug + foreign id', viaOwnSlug],
  ] as const) {
    it(`cannot get A's project via ${label}`, async () => {
      await expectStatus(() => getProject(bob.headers, ref()), 404)
    })
    it(`cannot update A's project via ${label}`, async () => {
      await expectStatus(
        () => updateProject(bob.headers, { ...ref(), project: { name: 'pwned' } }),
        404,
      )
    })
    it(`cannot delete A's project via ${label}`, async () => {
      await expectStatus(() => deleteProject(bob.headers, ref()), 404)
    })
  }

  it('cannot create in org A', async () => {
    await expectStatus(
      () => createProject(bob.headers, { tenant: orgA, project: { name: 'x' } }),
      404,
    )
  })

  it("leaves A's project unchanged", async () => {
    await expect(
      getProject(alice.headers, { tenant: orgA, id: projectA.id }),
    ).resolves.toMatchObject({
      name: 'Alpha',
    })
  })
})

describe('input contracts (invariant 9)', () => {
  it('treats a malformed tenant selector as an unknown tenant (404, not 400)', async () => {
    await expectStatus(() => listProjects(alice.headers, { tenant: 'NOT A SLUG' }), 404)
    await expectStatus(() => getProject(alice.headers, { tenant: '', id: projectA.id }), 404)
  })

  it('rejects an empty update (400) and a malformed project id (400)', async () => {
    await expectStatus(
      () => updateProject(alice.headers, { tenant: orgA, id: projectA.id, project: {} }),
      400,
    )
    await expectStatus(() => getProject(alice.headers, { tenant: orgA, id: 'not-a-uuid' }), 400)
  })

  it('rejects organizationId inside project fields', async () => {
    await expectStatus(
      () =>
        createProject(alice.headers, {
          tenant: orgA,
          project: { name: 'x', organizationId: 'other' },
        }),
      400,
    )
  })

  it('rejects organizationId at the top level', async () => {
    await expectStatus(
      () => listProjects(alice.headers, { tenant: orgA, organizationId: 'other' }),
      400,
    )
  })
})

describe('invitations', () => {
  it('owner invites, invitee accepts, then sees the tenant; members cannot invite', async () => {
    const carol = await signUp()
    await expectStatus(() => listProjects(carol.headers, { tenant: orgA }), 404)

    const { invitationId, link } = await inviteMember(alice.headers, {
      tenant: orgA,
      email: carol.email,
    })
    expect(link).toContain(invitationId)

    await acceptInvitation(carol.headers, { invitationId })
    const names = (await listProjects(carol.headers, { tenant: orgA })).map((p) => p.name)
    expect(names).toContain('Alpha')

    await expectStatus(
      () => inviteMember(carol.headers, { tenant: orgA, email: 'x@test.local' }),
      403,
    )
  })

  it('a non-member cannot invite into a foreign tenant (404)', async () => {
    await expectStatus(
      () => inviteMember(bob.headers, { tenant: orgA, email: 'x@test.local' }),
      404,
    )
  })

  it("an invitation can't be accepted by a different user", async () => {
    const dave = await signUp()
    const { invitationId } = await inviteMember(alice.headers, { tenant: orgA, email: dave.email })
    // Wrong recipient: the same non-disclosing 404 as an unknown invitation, and no membership.
    await expectStatus(() => acceptInvitation(bob.headers, { invitationId }), 404)
    await expectStatus(
      () => acceptInvitation(bob.headers, { invitationId: 'no-such-invitation' }),
      404,
    )
    await expectStatus(() => listProjects(bob.headers, { tenant: orgA }), 404)
    // The intended invitee can still accept the same invitation afterwards.
    await acceptInvitation(dave.headers, { invitationId })
    const names = (await listProjects(dave.headers, { tenant: orgA })).map((p) => p.name)
    expect(names).toContain('Alpha')
  })
})
