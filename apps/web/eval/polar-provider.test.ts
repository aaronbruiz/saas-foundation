// ADR-0022 POC: the real Polar adapter (providers/polar.ts) against the Polar sandbox. Not part of
// `pnpm test`; run with `vitest run --config vitest.eval.config.ts` and POLAR_EVAL_RUN=<slug>.
// Uses the sandbox token and eval emails from apps/web/.dev.vars; cleans up its customer.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  NoSuccessor,
  polarClient,
  polarMembers,
  polarProvider,
} from '../src/modules/billing/providers/polar'

const vars = env as unknown as Record<string, string | undefined>
const run = vars.POLAR_EVAL_RUN ?? ''
const required = (key: string) => {
  const v = vars[key]
  if (!v) throw new Error(`${key} missing in apps/web/.dev.vars`)
  return v
}

describe.runIf(run !== '')('polar adapter against the sandbox', () => {
  it('checkout, portal and member sync on one organization customer', async () => {
    if (!/^[a-z0-9-]{4,40}$/.test(run)) throw new Error('POLAR_EVAL_RUN must be a short slug')
    const config = {
      accessToken: required('POLAR_SANDBOX_ACCESS_TOKEN'),
      server: 'sandbox' as const,
    }
    const polar = polarClient(config)
    const provider = polarProvider(config)
    const members = polarMembers(config)
    const orgId = `eval-${run}-org`
    const owner = { userId: `eval-${run}-owner`, email: required('POLAR_EVAL_OWNER_EMAIL') }
    const next = { userId: `eval-${run}-next`, email: required('POLAR_EVAL_NEW_OWNER_EMAIL') }
    const checkoutReq = {
      organizationId: orgId,
      organizationName: `Eval ${run}`,
      customerId: null,
      userId: owner.userId,
      customerEmail: owner.email,
      priceKey: 'pro_monthly',
      trialDays: 14,
      successUrl: 'http://localhost:3000/t/eval/billing?checkout=success',
      cancelUrl: 'http://localhost:3000/t/eval/billing',
    }
    const memberList = async (customerId: string) =>
      (await polar.customers.members.list(customerId, {})).items.map((m) => ({
        ext: m.external_id,
        role: m.role,
      }))

    try {
      // Checkout creates the team customer once (named after the organization), owner = caller.
      const [url1, url2] = await Promise.all([
        provider.checkout(checkoutReq),
        provider.checkout(checkoutReq),
      ])
      expect(url1).toMatch(/^https:\/\/sandbox\.polar\.sh\/checkout\//)
      expect(url2).toMatch(/^https:\/\/sandbox\.polar\.sh\/checkout\//)
      const customer = await polar.customers.getExternal(orgId)
      expect(customer).toMatchObject({ type: 'team', name: `Eval ${run}` })
      expect(await memberList(customer.id)).toEqual([{ ext: owner.userId, role: 'owner' }])
      console.log('[eval] checkout ok; customer', customer.id)

      // Unknown price key → PriceNotFound (the service answers 503).
      await expect(provider.checkout({ ...checkoutReq, priceKey: 'nope' })).rejects.toThrow(
        /price_key nope/,
      )

      // Grant, then revoke the Polar owner: the successor is promoted first, then the owner goes.
      await members.grant(orgId, next)
      await members.grant(orgId, next) // idempotent
      expect(await memberList(customer.id)).toEqual(
        expect.arrayContaining([
          { ext: owner.userId, role: 'owner' },
          { ext: next.userId, role: 'billing_manager' },
        ]),
      )
      await members.revoke(orgId, owner.userId, [next])
      await members.revoke(orgId, owner.userId, [next]) // idempotent
      expect(await memberList(customer.id)).toEqual([{ ext: next.userId, role: 'owner' }])
      console.log('[eval] revoke with successor ok')

      // The last owner can't be revoked (Polar refuses; we refuse first).
      await expect(members.revoke(orgId, next.userId, [])).rejects.toBeInstanceOf(NoSuccessor)

      // Portal: the caller gets a session (and is re-added if a grant was missed).
      const portalUrl = await provider.portal({
        organizationId: orgId,
        customerId: customer.id,
        userId: owner.userId,
        customerEmail: owner.email,
        returnUrl: 'http://localhost:3000/t/eval/billing',
      })
      expect(portalUrl).toMatch(/^https:\/\/sandbox\.polar\.sh\//)
      expect(await memberList(customer.id)).toEqual(
        expect.arrayContaining([{ ext: owner.userId, role: 'billing_manager' }]),
      )
      console.log('[eval] portal ok (missing member repaired)')

      // Organization deletion: the customer goes; a second call is a no-op.
      await members.removeAccount(orgId)
      await members.removeAccount(orgId)
      await expect(polar.customers.getExternal(orgId)).rejects.toThrow()
      console.log('[eval] removeAccount ok')
    } finally {
      await members.removeAccount(orgId).catch(() => {})
    }
  }, 180_000)
})
