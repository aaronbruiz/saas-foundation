import { createAuth } from '@saas-foundation/auth'
import { billing, findOrganizationBySlug, listOwners } from '@saas-foundation/db'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEntitlements } from '../src/modules/billing/entitlements'
import type { WebhookParser } from '../src/modules/billing/provider'
import { polarWebhookParser } from '../src/modules/billing/providers/polar'
import { handleBillingWebhook, handlePolarWebhook } from '../src/modules/billing/webhook'
import { withDb } from '../src/server/db'
import { createOrg, randomIp, signUp, type TestUser } from './helpers'

// ADR-0022: the Polar webhook (Standard Webhooks signature, linking by metadata AND customer
// external_id) and the owner-role hooks that keep Polar members in step (revoke before, grant after).

const SECRET = 'polar_whs_test_only_not_a_real_secret'
const now = () => Math.floor(Date.now() / 1000)
const orgIdOf = async (slug: string) => (await withDb((db) => findOrganizationBySlug(db, slug)))!.id

// Standard Webhooks: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)); Polar's SDK accepts
// the dashboard secret as the raw key.
async function signed(body: string, id: string, secret = SECRET, t = now()) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${t}.${body}`)),
  )
  return {
    'webhook-id': id,
    'webhook-timestamp': String(t),
    'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
  }
}

type SubOpts = {
  type?: string
  subId?: string
  orgId?: string | null
  customerExternalId?: string | null
  status?: string
  priceKey?: string
  timestamp?: string
}
// The shape observed in the sandbox (eval run r2-0929), reduced to what the adapter reads.
function subscriptionEvent(o: SubOpts = {}) {
  return {
    type: o.type ?? 'subscription.updated',
    timestamp: o.timestamp ?? new Date().toISOString(),
    api_version: '2026-04',
    data: {
      id: o.subId ?? crypto.randomUUID(),
      status: o.status ?? 'active',
      customer_id: 'polar-customer-test',
      customer: {
        external_id: o.customerExternalId === undefined ? o.orgId : o.customerExternalId,
      },
      product_id: 'polar-product-test',
      product: { metadata: { price_key: o.priceKey ?? 'pro_monthly' } },
      metadata: o.orgId === null ? {} : { organization_id: o.orgId },
      current_period_end: '2030-01-01T00:00:00Z',
      cancel_at_period_end: false,
    },
  }
}

async function deliver(
  payload: unknown,
  opts: { secret?: string; id?: string; headers?: Record<string, string> } = {},
) {
  const body = JSON.stringify(payload)
  const headers = opts.headers ?? (await signed(body, opts.id ?? `msg_${crypto.randomUUID()}`))
  const res = await handlePolarWebhook(
    new Request('http://localhost/api/billing/webhooks/polar', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    }),
    'secret' in opts ? opts.secret : SECRET,
  )
  const json = res.headers.get('content-type')?.includes('json')
    ? ((await res.json()) as { outcome: string })
    : null
  return { status: res.status, outcome: json?.outcome }
}

async function newOrg(prefix: string) {
  const owner = await signUp()
  const slug = await createOrg(owner, prefix)
  return { owner, slug, orgId: await orgIdOf(slug) }
}

describe('polar webhook', () => {
  it('applies a subscription whose metadata and customer external_id name the organization', async () => {
    const { orgId } = await newOrg('pw-ok')
    expect(await deliver(subscriptionEvent({ orgId }))).toEqual({ status: 200, outcome: 'applied' })
    expect((await getEntitlements(orgId)).planKey).toBe('pro')
    const sub = await withDb((db) => billing(db, { orgId }).subscription())
    expect(sub).toMatchObject({ provider: 'polar', providerCustomerId: 'polar-customer-test' })
  })

  it("never applies an event to an organization another organization's customer names (cross-tenant)", async () => {
    const a = await newOrg('pw-a')
    const b = await newOrg('pw-b')
    // Metadata says A, but the customer is B's: recorded, not applied to either.
    const mismatch = subscriptionEvent({ orgId: a.orgId, customerExternalId: b.orgId })
    expect(await deliver(mismatch)).toEqual({ status: 200, outcome: 'unlinked' })
    const noExternal = subscriptionEvent({ orgId: a.orgId, customerExternalId: null })
    expect(await deliver(noExternal)).toEqual({ status: 200, outcome: 'unlinked' })
    for (const orgId of [a.orgId, b.orgId]) {
      expect((await getEntitlements(orgId)).planKey).toBe('free')
      expect(await withDb((db) => billing(db, { orgId }).subscription())).toBeNull()
    }
  })

  it('rejects bad signatures, stale timestamps and missing headers; fails closed without a secret', async () => {
    const { orgId } = await newOrg('pw-sig')
    const event = subscriptionEvent({ orgId })
    const body = JSON.stringify(event)
    const id = `msg_${crypto.randomUUID()}`
    expect((await deliver(event, { headers: await signed(body, id, 'wrong-secret') })).status).toBe(
      400,
    )
    const stale = await signed(body, id, SECRET, now() - 3600)
    expect((await deliver(event, { headers: stale })).status).toBe(400)
    expect((await deliver(event, { headers: {} })).status).toBe(400)
    expect((await deliver(event, { secret: undefined })).status).toBe(503)
    expect((await getEntitlements(orgId)).planKey).toBe('free')
  })

  it('deduplicates by webhook-id and records other or unknown event types without applying', async () => {
    const { orgId } = await newOrg('pw-dup')
    const id = `msg_${crypto.randomUUID()}`
    expect((await deliver(subscriptionEvent({ orgId }), { id })).outcome).toBe('applied')
    const canceled = subscriptionEvent({ orgId, status: 'canceled' })
    expect(await deliver(canceled, { id })).toEqual({ status: 200, outcome: 'duplicate' })
    expect((await getEntitlements(orgId)).planKey).toBe('pro')

    const member = { type: 'member.created', timestamp: new Date().toISOString(), data: {} }
    expect(await deliver(member)).toEqual({ status: 200, outcome: 'ignored' })
    const future = { type: 'future.event', timestamp: new Date().toISOString(), data: {} }
    expect(await deliver(future)).toEqual({ status: 200, outcome: 'ignored' })
  })

  it('maps revoked to canceled, ending the plan', async () => {
    const { orgId } = await newOrg('pw-rev')
    const subId = crypto.randomUUID()
    await deliver(subscriptionEvent({ orgId, subId }))
    const revoked = subscriptionEvent({
      orgId,
      subId,
      type: 'subscription.revoked',
      status: 'canceled',
    })
    expect((await deliver(revoked)).outcome).toBe('applied')
    expect((await getEntitlements(orgId)).planKey).toBe('free')
  })
})

describe('polar webhook in Polar mode (subscription re-read)', () => {
  const config = { accessToken: 'polar_oat_test_only', server: 'sandbox' as const }
  afterEach(() => vi.unstubAllGlobals())

  /** Polar's GET /v1/subscriptions/{id}, answering `state` (or failing with `status`). */
  function stubPolar(state: ReturnType<typeof subscriptionEvent>['data'] | { status: number }) {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      calls.push(new URL(url).pathname)
      if ('id' in state) return Response.json(state)
      return new Response('{"detail":"unavailable"}', {
        status: state.status,
        headers: { 'content-type': 'application/json' },
      })
    })
    return calls
  }
  async function deliverWith(parse: WebhookParser, payload: unknown, id: string) {
    const body = JSON.stringify(payload)
    const res = await handleBillingWebhook(
      new Request('http://localhost/api/billing/webhooks/polar', {
        method: 'POST',
        headers: { ...(await signed(body, id)), 'content-type': 'application/json' },
        body,
      }),
      SECRET,
      parse,
    )
    return {
      status: res.status,
      outcome: res.ok ? ((await res.json()) as { outcome: string }).outcome : undefined,
    }
  }

  it("applies the subscription's current state, not the event's (a late older event can't restore it)", async () => {
    const { orgId } = await newOrg('pw-fresh')
    const subId = crypto.randomUUID()
    // The delivery says active, but Polar already has it canceled.
    const late = subscriptionEvent({ orgId, subId, status: 'active' })
    const calls = stubPolar(subscriptionEvent({ orgId, subId, status: 'canceled' }).data)
    const res = await deliverWith(polarWebhookParser(config), late, `msg_${crypto.randomUUID()}`)
    expect(res).toEqual({ status: 200, outcome: 'applied' })
    expect(calls).toEqual([`/v1/subscriptions/${subId}`])
    const sub = await withDb((db) => billing(db, { orgId }).subscription())
    expect(sub?.status).toBe('canceled')
    expect((await getEntitlements(orgId)).planKey).toBe('free')
  })

  it('answers 503 and records nothing when Polar cannot be read, so the retry applies', async () => {
    const { orgId } = await newOrg('pw-retry')
    const event = subscriptionEvent({ orgId })
    const id = `msg_${crypto.randomUUID()}`
    stubPolar({ status: 500 })
    expect((await deliverWith(polarWebhookParser(config), event, id)).status).toBe(503)
    expect((await deliverWith(polarWebhookParser('unconfigured'), event, id)).status).toBe(503)
    expect((await getEntitlements(orgId)).planKey).toBe('free')
    stubPolar(event.data)
    expect(await deliverWith(polarWebhookParser(config), event, id)).toEqual({
      status: 200,
      outcome: 'applied',
    })
    expect((await getEntitlements(orgId)).planKey).toBe('pro')
  })
})

describe('owner-role hooks (Polar members)', () => {
  type Call = [string, string, string?]
  function fakeMembers(fail: { revoke?: boolean; grant?: boolean; removeAccount?: boolean } = {}) {
    const calls: Call[] = []
    const step = (name: keyof typeof fail) => async (orgId: string, userId?: string) => {
      calls.push([name, orgId, userId])
      if (fail[name]) throw new Error(`${name} failed`)
    }
    return {
      calls,
      members: {
        revoke: step('revoke'),
        grant: step('grant'),
        removeAccount: step('removeAccount'),
      },
    }
  }

  /** Better Auth with the fake member sync, called through its real HTTP handler. */
  function post(members: ReturnType<typeof fakeMembers>['members'], as: TestUser) {
    return (path: string, body: unknown) =>
      withDb((db) =>
        createAuth({
          db,
          secret: env.BETTER_AUTH_SECRET,
          baseURL: env.BETTER_AUTH_URL,
          allowSignUp: () => true,
          sendEmail: async () => {},
          billing: {
            memberLimit: async () => null,
            blocksDeletion: async () => false,
            members,
          },
        }).handler(
          new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: env.BETTER_AUTH_URL,
              'cf-connecting-ip': randomIp(),
              cookie: as.headers.get('cookie')!,
            },
            body: JSON.stringify(body),
          }),
        ),
      )
  }

  type RawQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
  const query = (sql: string, params: unknown[]) =>
    withDb((db) => (db as unknown as { $client: { query: RawQuery } }).$client.query(sql, params))
  const roleOf = async (orgId: string, userId: string) =>
    (
      await query('SELECT id, role FROM member WHERE organization_id = $1 AND user_id = $2', [
        orgId,
        userId,
      ])
    ).rows[0] as { id: string; role: string } | undefined

  /** An organization with owner A and a second member B (added through an invitation). */
  async function orgWithTwo(role: 'owner' | 'admin') {
    const { owner: a, orgId } = await newOrg('ph')
    const b = await signUp()
    const { members } = fakeMembers()
    const inv = await post(members, a)('/organization/invite-member', {
      email: b.email,
      role,
      organizationId: orgId,
    })
    const { id: invitationId } = (await inv.json()) as { id: string }
    expect((await post(members, b)('/organization/accept-invitation', { invitationId })).ok).toBe(
      true,
    )
    return { a, b, orgId }
  }

  it('grants a user who becomes owner (invitation or promotion), and a failed grant changes nothing else', async () => {
    const { owner: a, orgId } = await newOrg('ph-grant')
    const b = await signUp()
    const sync = fakeMembers({ grant: true })
    const inv = await post(sync.members, a)('/organization/invite-member', {
      email: b.email,
      role: 'owner',
      organizationId: orgId,
    })
    const { id: invitationId } = (await inv.json()) as { id: string }
    const accepted = await post(sync.members, b)('/organization/accept-invitation', {
      invitationId,
    })
    expect(accepted.ok).toBe(true)
    expect(sync.calls).toContainEqual(['grant', orgId, b.userId])
    expect((await roleOf(orgId, b.userId))?.role).toBe('owner')

    const { a: a2, b: b2, orgId: org2 } = await orgWithTwo('admin')
    const promote = fakeMembers()
    const m = (await roleOf(org2, b2.userId))!
    const res = await post(promote.members, a2)('/organization/update-member-role', {
      memberId: m.id,
      role: 'owner',
      organizationId: org2,
    })
    expect(res.ok).toBe(true)
    expect(promote.calls).toEqual([['grant', org2, b2.userId]])
  })

  it('revokes before an owner is demoted, and refuses the demotion when Polar cannot be updated', async () => {
    const { a, b, orgId } = await orgWithTwo('owner')
    const failing = fakeMembers({ revoke: true })
    const target = (await roleOf(orgId, a.userId))!
    const refused = await post(failing.members, b)('/organization/update-member-role', {
      memberId: target.id,
      role: 'admin',
      organizationId: orgId,
    })
    expect(refused.status).toBe(503)
    expect((await roleOf(orgId, a.userId))?.role).toBe('owner')

    const ok = fakeMembers()
    const res = await post(ok.members, b)('/organization/update-member-role', {
      memberId: target.id,
      role: 'admin',
      organizationId: orgId,
    })
    expect(res.ok).toBe(true)
    expect(ok.calls).toEqual([['revoke', orgId, a.userId]])
    expect((await roleOf(orgId, a.userId))?.role).toBe('admin')
  })

  it('revokes before an owner is removed or leaves; refused when Polar cannot be updated', async () => {
    const { a, b, orgId } = await orgWithTwo('owner')
    const failing = fakeMembers({ revoke: true })
    const removeBody = { memberIdOrEmail: b.email, organizationId: orgId }
    expect((await post(failing.members, a)('/organization/remove-member', removeBody)).status).toBe(
      503,
    )
    expect(await roleOf(orgId, b.userId)).toBeDefined()
    expect(
      (await post(failing.members, b)('/organization/leave', { organizationId: orgId })).status,
    ).toBe(503)
    expect(await roleOf(orgId, b.userId)).toBeDefined()

    const ok = fakeMembers()
    expect((await post(ok.members, b)('/organization/leave', { organizationId: orgId })).ok).toBe(
      true,
    )
    expect(ok.calls[0]).toEqual(['revoke', orgId, b.userId])
    expect(await roleOf(orgId, b.userId)).toBeUndefined()
  })

  it('treats a multi-role owner ("owner,admin") as an owner when demoted or leaving', async () => {
    const { a, b, orgId } = await orgWithTwo('owner')
    const setup = fakeMembers()
    const mb = (await roleOf(orgId, b.userId))!
    await post(setup.members, a)('/organization/update-member-role', {
      memberId: mb.id,
      role: ['owner', 'admin'],
      organizationId: orgId,
    })
    expect((await roleOf(orgId, b.userId))?.role).toBe('owner,admin')
    const ma = (await roleOf(orgId, a.userId))!
    await post(setup.members, b)('/organization/update-member-role', {
      memberId: ma.id,
      role: ['owner', 'admin'],
      organizationId: orgId,
    })
    expect(setup.calls).toEqual([]) // still owners: nothing to revoke or grant

    const demote = fakeMembers()
    const res = await post(demote.members, a)('/organization/update-member-role', {
      memberId: mb.id,
      role: 'admin',
      organizationId: orgId,
    })
    expect(res.ok).toBe(true)
    expect(demote.calls).toEqual([['revoke', orgId, b.userId]])

    const leave = fakeMembers({ revoke: true })
    expect(
      (await post(leave.members, a)('/organization/leave', { organizationId: orgId })).status,
    ).toBe(503)
    expect(leave.calls).toEqual([['revoke', orgId, a.userId]])
  })

  it('lists multi-role owners as successors', async () => {
    const { a, b, orgId } = await orgWithTwo('owner')
    const mb = (await roleOf(orgId, b.userId))!
    await post(fakeMembers().members, a)('/organization/update-member-role', {
      memberId: mb.id,
      role: ['admin', 'owner'],
      organizationId: orgId,
    })
    const owners = await withDb((db) => listOwners(db, orgId))
    expect(owners.map((o) => o.userId).sort()).toEqual([a.userId, b.userId].sort())
  })

  it("doesn't touch Polar for non-owner role changes", async () => {
    const { a, b, orgId } = await orgWithTwo('admin')
    const sync = fakeMembers()
    const m = (await roleOf(orgId, b.userId))!
    await post(sync.members, a)('/organization/update-member-role', {
      memberId: m.id,
      role: 'member',
      organizationId: orgId,
    })
    await post(sync.members, a)('/organization/remove-member', {
      memberIdOrEmail: b.email,
      organizationId: orgId,
    })
    expect(sync.calls).toEqual([])
  })

  it('removes the Polar customer only for an owner allowed to delete, before the organization goes', async () => {
    const { a, b, orgId } = await orgWithTwo('admin')
    const sync = fakeMembers()
    const byAdmin = await post(sync.members, b)('/organization/delete', { organizationId: orgId })
    expect(byAdmin.ok).toBe(false)
    expect(sync.calls).toEqual([])

    const failing = fakeMembers({ removeAccount: true })
    const refused = await post(failing.members, a)('/organization/delete', {
      organizationId: orgId,
    })
    expect(refused.status).toBe(503)
    expect(await roleOf(orgId, a.userId)).toBeDefined()

    const deleted = await post(sync.members, a)('/organization/delete', { organizationId: orgId })
    expect(deleted.ok).toBe(true)
    expect(sync.calls).toEqual([['removeAccount', orgId, undefined]])
    expect(await roleOf(orgId, a.userId)).toBeUndefined()
  })
})
