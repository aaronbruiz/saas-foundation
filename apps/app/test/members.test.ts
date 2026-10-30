import { beforeAll, describe, expect, it } from 'vitest'
import { rawDb } from '@saas-foundation/db/internal'
import { withDb } from '../src/server/db'
import {
  acceptInvitation,
  inviteMember,
  listInvitations,
  listMembers,
  revokeInvitation,
} from '../src/modules/organizations/service'
import { createOrg, expectStatus, joinAs, onPaidPlan, signUp, type TestUser } from './helpers'

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
    await sql(`UPDATE invitation SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      expired.invitationId,
    ])
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
