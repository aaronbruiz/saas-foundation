import { beforeAll, describe, expect, it } from 'vitest'
import { cancelPendingInvitation } from '@saas-foundation/db'
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

const expire = (id: string) =>
  sql(`UPDATE invitation SET expires_at = now() - interval '1 second' WHERE id = $1`, [id])

// One call per new server boundary, for the checks every one of them shares.
const boundaries = {
  listMembers: (h: Headers, input: object) => listMembers(h, input),
  listInvitations: (h: Headers, input: object) => listInvitations(h, input),
  revokeInvitation: (h: Headers, input: object) =>
    revokeInvitation(h, { invitationId: 'any', ...input }),
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
