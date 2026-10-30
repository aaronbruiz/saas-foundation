import { beforeAll, describe, expect, it } from 'vitest'
import {
  cancelPendingInvitation,
  removeNonOwnerMember,
  updateNonOwnerMemberRole,
} from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { withDb } from '../src/server/db'
import {
  acceptInvitation,
  inviteMember,
  listInvitations,
  getTenant,
  getViewer,
  listMembers,
  removeMember,
  revokeInvitation,
  updateMemberRole,
} from '../src/modules/organizations/service'
import {
  authPost,
  createOrg,
  expectStatus,
  joinAs,
  onPaidPlan,
  signUp,
  type TestUser,
} from './helpers'

// Members page (owner decisions 2026-10-29): every member reads the member list; pending
// invitations and revoking need `member:invite` (owner, admin). Outside the tenant, 404.

let owner: TestUser
let admin: TestUser
let member: TestUser
let outsider: TestUser
let orgA: string
let orgB: string

beforeAll(async () => {
  ;[owner, outsider] = await Promise.all([signUp(), signUp()])
  ;[orgA, orgB] = await Promise.all([createOrg(owner, 'members'), createOrg(outsider, 'other')])
  // Several invitations below: stay clear of the default plan's seat limit (ADR-0020).
  await Promise.all([onPaidPlan(orgA), onPaidPlan(orgB)])
  admin = await joinAs(owner, orgA, 'admin')
  member = await joinAs(owner, orgA, 'member')
})

const invite = (by: TestUser, tenant: string) =>
  inviteMember(by.headers, { tenant, email: `i-${crypto.randomUUID()}@test.local` })

type Query = (q: string, p: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
const sql = (q: string, p: unknown[]) =>
  withDb((db) => (rawDb(db) as unknown as { $client: { query: Query } }).$client.query(q, p))

const statusOf = async (id: string) =>
  (await sql('SELECT status FROM invitation WHERE id = $1', [id])).rows[0]?.status

const expire = (id: string) =>
  sql(`UPDATE invitation SET expires_at = now() - interval '1 second' WHERE id = $1`, [id])

// One call per new server boundary, for the checks every one of them shares.
const boundaries = {
  listMembers: (h: Headers, input: object) => listMembers(h, input),
  listInvitations: (h: Headers, input: object) => listInvitations(h, input),
  revokeInvitation: (h: Headers, input: object) =>
    revokeInvitation(h, { invitationId: 'any', ...input }),
  removeMember: (h: Headers, input: object) => removeMember(h, { memberId: 'any', ...input }),
  updateMemberRole: (h: Headers, input: object) =>
    updateMemberRole(h, { memberId: 'any', role: 'member', ...input }),
}

describe('every boundary', () => {
  for (const [name, call] of Object.entries(boundaries)) {
    it(`${name}: an unknown tenant is a 404`, async () => {
      await expectStatus(
        () => call(owner.headers, { tenant: `none-${crypto.randomUUID().slice(0, 8)}` }),
        404,
      )
    })
    it(`${name}: a malformed slug is an unknown tenant (404, not 400)`, async () => {
      await expectStatus(() => call(owner.headers, { tenant: 'Not A Slug!' }), 404)
    })
  }
})

describe('member list', () => {
  it('every member sees all members with name, email and role, oldest first', async () => {
    for (const user of [owner, admin, member]) {
      const rows = await listMembers(user.headers, { tenant: orgA })
      expect(rows.map((r) => [r.email, r.role])).toEqual([
        [owner.email, 'owner'],
        [admin.email, 'admin'],
        [member.email, 'member'],
      ])
      expect(rows[0]?.name).toEqual(expect.any(String))
    }
  })

  it('a non-member gets 404 for another tenant, never 403', async () => {
    await expectStatus(() => listMembers(outsider.headers, { tenant: orgA }), 404)
    await expectStatus(() => listMembers(owner.headers, { tenant: orgB }), 404)
  })

  it('rejects an organizationId input field (400)', async () => {
    await expectStatus(() => listMembers(owner.headers, { tenant: orgA, organizationId: 'x' }), 400)
  })
})

describe('pending invitations', () => {
  it('owner and admin see pending invitations; a member gets 403', async () => {
    const { invitationId } = await invite(owner, orgA)
    for (const user of [owner, admin]) {
      const ids = (await listInvitations(user.headers, { tenant: orgA })).map((i) => i.id)
      expect(ids).toContain(invitationId)
    }
    await expectStatus(() => listInvitations(member.headers, { tenant: orgA }), 403)
  })

  it("doesn't list accepted or expired invitations", async () => {
    const carol = await signUp()
    const accepted = await inviteMember(owner.headers, { tenant: orgA, email: carol.email })
    await acceptInvitation(carol.headers, { invitationId: accepted.invitationId })
    const expired = await invite(owner, orgA)
    await expire(expired.invitationId)
    const ids = (await listInvitations(owner.headers, { tenant: orgA })).map((i) => i.id)
    expect(ids).not.toContain(accepted.invitationId)
    expect(ids).not.toContain(expired.invitationId)
  })

  it("doesn't include another tenant's invitations; an outsider gets 404", async () => {
    const { invitationId } = await invite(outsider, orgB)
    const ids = (await listInvitations(owner.headers, { tenant: orgA })).map((i) => i.id)
    expect(ids).not.toContain(invitationId)
    await expectStatus(() => listInvitations(outsider.headers, { tenant: orgA }), 404)
  })
})

describe('revoking an invitation', () => {
  it('an admin revokes a pending invitation: it leaves the list and can no longer be accepted', async () => {
    const dave = await signUp()
    const { invitationId } = await inviteMember(owner.headers, { tenant: orgA, email: dave.email })
    await revokeInvitation(admin.headers, { tenant: orgA, invitationId })
    const ids = (await listInvitations(owner.headers, { tenant: orgA })).map((i) => i.id)
    expect(ids).not.toContain(invitationId)
    await expectStatus(() => acceptInvitation(dave.headers, { invitationId }), 404)
  })

  it('a member gets 403 and the invitation stays pending', async () => {
    const { invitationId } = await invite(owner, orgA)
    await expectStatus(() => revokeInvitation(member.headers, { tenant: orgA, invitationId }), 403)
    expect(await statusOf(invitationId)).toBe('pending')
  })

  it("another tenant's invitation id via the caller's own slug is a 404 and stays pending", async () => {
    const { invitationId } = await invite(outsider, orgB)
    await expectStatus(() => revokeInvitation(owner.headers, { tenant: orgA, invitationId }), 404)
    expect(await statusOf(invitationId)).toBe('pending')
  })

  it("an outsider gets 404 revoking in a tenant they don't belong to", async () => {
    const { invitationId } = await invite(owner, orgA)
    await expectStatus(
      () => revokeInvitation(outsider.headers, { tenant: orgA, invitationId }),
      404,
    )
    expect(await statusOf(invitationId)).toBe('pending')
  })

  it('an unknown id or an invitation no longer pending is a 404', async () => {
    await expectStatus(
      () => revokeInvitation(owner.headers, { tenant: orgA, invitationId: 'no-such-invitation' }),
      404,
    )
    const erin = await signUp()
    const accepted = await inviteMember(owner.headers, { tenant: orgA, email: erin.email })
    await acceptInvitation(erin.headers, { invitationId: accepted.invitationId })
    await expectStatus(
      () => revokeInvitation(owner.headers, { tenant: orgA, invitationId: accepted.invitationId }),
      404,
    )
    expect(await statusOf(accepted.invitationId)).toBe('accepted')

    const revoked = await invite(owner, orgA)
    await revokeInvitation(owner.headers, { tenant: orgA, invitationId: revoked.invitationId })
    await expectStatus(
      () => revokeInvitation(owner.headers, { tenant: orgA, invitationId: revoked.invitationId }),
      404,
    )
  })

  it('an expired invitation is a 404 and stays as it is', async () => {
    const { invitationId } = await invite(owner, orgA)
    await expire(invitationId)
    await expectStatus(() => revokeInvitation(owner.headers, { tenant: orgA, invitationId }), 404)
    expect(await statusOf(invitationId)).toBe('pending')
  })

  it("the cancel write doesn't overwrite an invitation accepted after the pending check", async () => {
    // The race the service's 404 check can't close on its own: acceptance lands between the
    // check and the write. The write itself must refuse a non-pending invitation.
    const fay = await signUp()
    const { invitationId } = await inviteMember(owner.headers, { tenant: orgA, email: fay.email })
    await acceptInvitation(fay.headers, { invitationId })
    const orgId = (
      await sql('SELECT organization_id FROM invitation WHERE id = $1', [invitationId])
    ).rows[0]?.organization_id as string
    expect(await withDb((db) => cancelPendingInvitation(db, orgId, invitationId))).toBe(false)
    expect(await statusOf(invitationId)).toBe('accepted')
  })

  it('rejects an empty id or extra fields (400)', async () => {
    await expectStatus(
      () => revokeInvitation(owner.headers, { tenant: orgA, invitationId: '' }),
      400,
    )
    await expectStatus(
      () =>
        revokeInvitation(owner.headers, { tenant: orgA, invitationId: 'x', organizationId: 'y' }),
      400,
    )
  })
})

// Owner decisions 2026-10-30: `member:manage` (owner, admin) acts on non-owners only; an admin may
// demote or remove themselves; a removed member's pending invitations stay valid.
describe('managing members', () => {
  const rowOf = async (user: TestUser, tenant = orgA) => {
    const rows = await listMembers(owner.headers, { tenant })
    return rows.find((r) => r.email === user.email)
  }
  const idOf = async (user: TestUser) => (await rowOf(user))!.id
  const setRole = (id: string, role: string) =>
    sql('UPDATE member SET role = $1 WHERE id = $2', [role, id])
  const orgIdOfA = async () =>
    (await sql('SELECT id FROM organization WHERE slug = $1', [orgA])).rows[0]?.id as string

  it('every member sees each member id, and it differs per member', async () => {
    const ids = (await listMembers(member.headers, { tenant: orgA })).map((r) => r.id)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const [name, actor] of [
    ['an owner', () => owner],
    ['an admin', () => admin],
  ] as const) {
    it(`${name} makes a member an admin and an admin a member`, async () => {
      const target = await joinAs(owner, orgA, 'member')
      const memberId = await idOf(target)
      await updateMemberRole(actor().headers, { tenant: orgA, memberId, role: 'admin' })
      expect((await rowOf(target))?.role).toBe('admin')
      await updateMemberRole(actor().headers, { tenant: orgA, memberId, role: 'member' })
      expect((await rowOf(target))?.role).toBe('member')
    })

    it(`${name} removes a member, whose next request to the tenant is a 404`, async () => {
      const target = await joinAs(owner, orgA, 'member')
      const memberId = await idOf(target)
      await expect(removeMember(actor().headers, { tenant: orgA, memberId })).resolves.toEqual({
        removedSelf: false,
      })
      expect(await rowOf(target)).toBeUndefined()
      await expectStatus(() => getTenant(target.headers, { tenant: orgA }), 404)
    })
  }

  it('an admin demotes themselves and loses member:manage on the next request', async () => {
    const self = await joinAs(owner, orgA, 'admin')
    await updateMemberRole(self.headers, {
      tenant: orgA,
      memberId: await idOf(self),
      role: 'member',
    })
    const { role, capabilities } = await getTenant(self.headers, { tenant: orgA })
    expect(role).toBe('member')
    expect(capabilities).not.toContain('member:manage')
  })

  it('an admin removes themselves: tenant 404, session and landing data still work', async () => {
    const self = await joinAs(owner, orgA, 'admin')
    const organizationId = await orgIdOfA()
    const active = await authPost('/organization/set-active', { organizationId }, undefined, self)
    expect(active.ok).toBe(true)
    await expect(
      removeMember(self.headers, { tenant: orgA, memberId: await idOf(self) }),
    ).resolves.toEqual({ removedSelf: true })
    await expectStatus(() => getTenant(self.headers, { tenant: orgA }), 404)
    // Better Auth's endpoint clears the active organization and this write doesn't; nothing reads it.
    await expect(getViewer(self.headers)).resolves.toMatchObject({
      email: self.email,
      organizations: [],
    })
  })

  it('a member gets 403 on any row, their own included, and nothing changes', async () => {
    const target = await joinAs(owner, orgA, 'member')
    for (const memberId of [await idOf(target), await idOf(member)]) {
      await expectStatus(() => removeMember(member.headers, { tenant: orgA, memberId }), 403)
      await expectStatus(
        () => updateMemberRole(member.headers, { tenant: orgA, memberId, role: 'admin' }),
        403,
      )
    }
    expect((await rowOf(target))?.role).toBe('member')
    expect((await rowOf(member))?.role).toBe('member')
  })

  it('an owner row gets 403 from any caller, a co-owner included, and stays', async () => {
    const coOwner = await joinAs(owner, orgA, 'admin')
    const coOwnerId = await idOf(coOwner)
    await setRole(coOwnerId, 'owner')
    for (const caller of [owner, admin]) {
      for (const memberId of [coOwnerId, await idOf(owner)]) {
        await expectStatus(() => removeMember(caller.headers, { tenant: orgA, memberId }), 403)
        await expectStatus(
          () => updateMemberRole(caller.headers, { tenant: orgA, memberId, role: 'member' }),
          403,
        )
      }
    }
    expect((await rowOf(coOwner))?.role).toBe('owner')
    expect((await rowOf(owner))?.role).toBe('owner')
  })

  it('a role listing owner among several is an owner row', async () => {
    const target = await joinAs(owner, orgA, 'admin')
    const memberId = await idOf(target)
    await setRole(memberId, 'admin, owner')
    await expectStatus(() => removeMember(owner.headers, { tenant: orgA, memberId }), 403)
    await expectStatus(
      () => updateMemberRole(owner.headers, { tenant: orgA, memberId, role: 'member' }),
      403,
    )
    expect((await rowOf(target))?.role).toBe('admin, owner')
  })

  it("the writes don't touch a member promoted to owner after the role check", async () => {
    // The race the service's check can't close on its own: the promotion lands between the check
    // and the write. The write itself must refuse an owner row.
    const target = await joinAs(owner, orgA, 'member')
    const memberId = await idOf(target)
    const orgId = await orgIdOfA()
    for (const role of ['owner', 'admin,owner', 'member, owner']) {
      await setRole(memberId, role)
      expect(await withDb((db) => removeNonOwnerMember(db, orgId, memberId))).toBe(false)
      expect(await withDb((db) => updateNonOwnerMemberRole(db, orgId, memberId, 'member'))).toBe(
        false,
      )
      expect((await rowOf(target))?.role).toBe(role)
    }
  })

  it("the writes don't touch another organization's member", async () => {
    const target = await joinAs(owner, orgA, 'member')
    const memberId = await idOf(target)
    const orgIdB = (await sql('SELECT id FROM organization WHERE slug = $1', [orgB])).rows[0]
      ?.id as string
    expect(await withDb((db) => removeNonOwnerMember(db, orgIdB, memberId))).toBe(false)
    expect(await withDb((db) => updateNonOwnerMemberRole(db, orgIdB, memberId, 'admin'))).toBe(
      false,
    )
    expect((await rowOf(target))?.role).toBe('member')
  })

  it("another tenant's member id via the caller's own slug is a 404, for every role", async () => {
    const foreign = await joinAs(outsider, orgB, 'member')
    const memberId = (await listMembers(outsider.headers, { tenant: orgB })).find(
      (r) => r.email === foreign.email,
    )!.id
    for (const caller of [owner, admin, member]) {
      await expectStatus(() => removeMember(caller.headers, { tenant: orgA, memberId }), 404)
      await expectStatus(
        () => updateMemberRole(caller.headers, { tenant: orgA, memberId, role: 'admin' }),
        404,
      )
    }
    const rows = await listMembers(outsider.headers, { tenant: orgB })
    expect(rows.find((r) => r.email === foreign.email)?.role).toBe('member')
  })

  it("an outsider gets 404 in a tenant they don't belong to, and nothing changes", async () => {
    const memberId = await idOf(member)
    await expectStatus(() => removeMember(outsider.headers, { tenant: orgA, memberId }), 404)
    await expectStatus(
      () => updateMemberRole(outsider.headers, { tenant: orgA, memberId, role: 'admin' }),
      404,
    )
    expect((await rowOf(member))?.role).toBe('member')
  })

  it('an unknown or already removed member id is a 404', async () => {
    const memberId = 'no-such-member'
    await expectStatus(() => removeMember(owner.headers, { tenant: orgA, memberId }), 404)
    await expectStatus(
      () => updateMemberRole(owner.headers, { tenant: orgA, memberId, role: 'admin' }),
      404,
    )
    const gone = await joinAs(owner, orgA, 'member')
    const goneId = await idOf(gone)
    await removeMember(owner.headers, { tenant: orgA, memberId: goneId })
    await expectStatus(() => removeMember(owner.headers, { tenant: orgA, memberId: goneId }), 404)
  })

  it('rejects another role, an empty id or extra fields (400)', async () => {
    const memberId = await idOf(member)
    for (const role of ['owner', 'superuser', '', 'admin,owner'])
      await expectStatus(
        () => updateMemberRole(owner.headers, { tenant: orgA, memberId, role }),
        400,
      )
    await expectStatus(() => removeMember(owner.headers, { tenant: orgA, memberId: '' }), 400)
    await expectStatus(
      () => updateMemberRole(owner.headers, { tenant: orgA, memberId: '', role: 'admin' }),
      400,
    )
    await expectStatus(
      () => removeMember(owner.headers, { tenant: orgA, memberId, organizationId: 'x' }),
      400,
    )
    await expectStatus(
      () =>
        updateMemberRole(owner.headers, {
          tenant: orgA,
          memberId,
          role: 'admin',
          organizationId: 'x',
        }),
      400,
    )
    expect((await rowOf(member))?.role).toBe('member')
  })

  it("a removed admin's pending invitation stays listed and can be accepted", async () => {
    const inviter = await joinAs(owner, orgA, 'admin')
    const invitee = await signUp()
    const { invitationId } = await inviteMember(inviter.headers, {
      tenant: orgA,
      email: invitee.email,
    })
    await removeMember(owner.headers, { tenant: orgA, memberId: await idOf(inviter) })
    const ids = (await listInvitations(owner.headers, { tenant: orgA })).map((i) => i.id)
    expect(ids).toContain(invitationId)
    await acceptInvitation(invitee.headers, { invitationId })
    expect((await rowOf(invitee))?.role).toBe('member')
  })

  it("a removed admin's pending invitation can still be revoked", async () => {
    const inviter = await joinAs(owner, orgA, 'admin')
    const invitee = await signUp()
    const { invitationId } = await inviteMember(inviter.headers, {
      tenant: orgA,
      email: invitee.email,
    })
    await removeMember(owner.headers, { tenant: orgA, memberId: await idOf(inviter) })
    await revokeInvitation(owner.headers, { tenant: orgA, invitationId })
    await expectStatus(() => acceptInvitation(invitee.headers, { invitationId }), 404)
    expect(await rowOf(invitee)).toBeUndefined()
  })
})
