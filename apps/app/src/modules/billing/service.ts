import { env } from 'cloudflare:workers'
import { billing, countMembers, gatedMemberWrite, projects } from '@saas-foundation/db'
import { StartCheckoutInput, TenantInput } from '@saas-foundation/contracts'
import { getTenantContext } from '../../server/context'
import { withDb } from '../../server/db'
import { HttpError, parseInput } from '../../server/errors'
import { authorize, can } from '../../server/permissions'
import { PLANS, entitlementsFor, isLive, purchasablePrices, trialDaysFor } from './policy'
import { configuredProvider, isMemberWriteUnknown } from './config'
import { CheckoutNotCreated, PriceNotFound, type BillingProvider } from './provider'

const BILLING_ACCESS_CLOSED =
  'Billing is closed for your account: it may be being deleted. If this persists, contact support.'

// Plain functions (testable in workerd); ./functions.ts adapts them. Every rule comes from
// ./policy (product) or the capability matrix (roles); this file only wires them (ADR-0020).

export async function getBillingOverview(headers: Headers, input: unknown) {
  const { tenant } = parseInput(TenantInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    authorize(ctx, 'billing:read')
    const sub = await billing(db, ctx).subscription()
    const entitlements = entitlementsFor(sub)
    return {
      plan: { key: entitlements.planKey, name: PLANS[entitlements.planKey].name },
      limits: entitlements.limits,
      usage: {
        projects: await projects(db, ctx).count(),
        members: await countMembers(db, ctx.orgId),
      },
      subscription: sub && {
        status: sub.status,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      },
      canManage: can(ctx.role, 'billing:manage'),
      // A new checkout only when nothing live exists; the portal once there's a customer.
      prices: isLive(sub) ? [] : purchasablePrices(),
      trialDays: trialDaysFor(sub),
      hasPortal: sub !== null,
    }
  })
}

export async function startCheckout(
  headers: Headers,
  input: unknown,
  provider: BillingProvider | null = configuredProvider(),
): Promise<{ url: string }> {
  const { tenant, price } = parseInput(StartCheckoutInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    authorize(ctx, 'billing:manage')
    if (!purchasablePrices().some((p) => p.key === price)) throw new HttpError(400, 'unknown price')
    const sub = await billing(db, ctx).subscription()
    // One subscription per organization (ADR-0020): changes go through the billing portal.
    if (isLive(sub))
      throw new HttpError(409, 'This organization already has a subscription. Use Manage billing.')
    if (!provider) throw new HttpError(503, 'Billing is not configured')
    // ADR-0043: counted before anything reaches the provider, so a deletion can't miss it.
    const repo = billing(db, ctx)
    if (!(await repo.startCheckoutAttempt()))
      throw new HttpError(409, 'This organization is being deleted.')
    const back = `${env.BETTER_AUTH_URL}/t/${ctx.slug}/billing`
    try {
      // ADR-0044: a checkout can put the caller into the provider, so it goes through their gate.
      const written = await gatedMemberWrite(
        db,
        ctx.orgId,
        ctx.userId,
        () =>
          provider.checkout({
            organizationId: ctx.orgId,
            organizationName: ctx.name,
            customerId: sub?.providerCustomerId ?? null,
            userId: ctx.userId,
            customerEmail: ctx.email,
            // Set by Cloudflare's edge, which overwrites any client value (like auth's rate limit).
            customerIp: headers.get('cf-connecting-ip'),
            priceKey: price,
            trialDays: trialDaysFor(sub),
            successUrl: `${back}?checkout=success`,
            cancelUrl: back,
          }),
        isMemberWriteUnknown,
      )
      if (!written.sent) {
        await repo.finishCheckoutAttempt()
        throw new HttpError(409, BILLING_ACCESS_CLOSED)
      }
      await repo.finishCheckoutAttempt()
      return { url: written.value }
    } catch (e) {
      // Anything else may have reached the provider: it stays counted, and blocks deletion, until
      // someone checks (runbook "Stuck checkout attempts"). No timeout can prove it never landed.
      if (e instanceof CheckoutNotCreated) await repo.finishCheckoutAttempt()
      if (e instanceof PriceNotFound) throw new HttpError(503, 'This price is not available yet')
      throw e
    }
  })
}

export async function openBillingPortal(
  headers: Headers,
  input: unknown,
  provider: BillingProvider | null = configuredProvider(),
): Promise<{ url: string }> {
  const { tenant } = parseInput(TenantInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    authorize(ctx, 'billing:manage')
    const sub = await billing(db, ctx).subscription()
    if (!sub) throw new HttpError(409, 'This organization has no billing account yet')
    if (!provider) throw new HttpError(503, 'Billing is not configured')
    const written = await gatedMemberWrite(
      db,
      ctx.orgId,
      ctx.userId,
      () =>
        provider.portal({
          organizationId: ctx.orgId,
          customerId: sub.providerCustomerId,
          userId: ctx.userId,
          customerEmail: ctx.email,
          returnUrl: `${env.BETTER_AUTH_URL}/t/${ctx.slug}/billing`,
        }),
      isMemberWriteUnknown,
    )
    if (!written.sent) throw new HttpError(409, BILLING_ACCESS_CLOSED)
    return { url: written.value }
  })
}
