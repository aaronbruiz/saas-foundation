// The only place that knows Polar (ADR-0022, AGENTS.md invariant 6). Polar is merchant of record:
// one Polar team customer per organization (`external_id` = organization id), whose members mirror
// the users holding `billing:manage`. Turns a signed webhook delivery into a provider-neutral event,
// creates checkout and portal sessions, and keeps customer members in sync. Nothing Polar-shaped
// leaves this file.
import { createPolar, webhooks } from '@polar-sh/sdk/2026-04'
import type { SubscriptionStatus } from '@saas-foundation/db'
import { z } from 'zod'
import {
  InvalidPayload,
  InvalidSignature,
  PriceNotFound,
  type BillingManager,
  type BillingMembers,
  type BillingProvider,
  type CheckoutRequest,
  type PortalRequest,
  type ProviderEvent,
  type WebhookParser,
} from '../provider'

export const PROVIDER = 'polar'

/** Metadata key our checkout sets (and Polar copies onto the subscription) to link it. */
export const ORGANIZATION_METADATA_KEY = 'organization_id'
/** Product metadata key naming the policy's price key (Polar has no lookup keys). */
export const PRICE_KEY_METADATA_KEY = 'price_key'

const STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'unpaid',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  canceled: 'canceled',
}

const id = z.string().min(1).max(255)
const metadata = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullish()
// Only the fields we store (run r2-0929: every subscription.* event carries them).
const subscriptionSchema = z.object({
  id,
  status: z.string(),
  customer_id: id,
  customer: z.object({ external_id: z.string().max(255).nullish() }),
  product_id: id.nullish(),
  product: z.object({ metadata }).nullish(),
  metadata,
  current_period_end: z.string().nullish(),
  cancel_at_period_end: z.boolean(),
})
const eventSchema = z.object({
  type: z.string().min(1).max(255),
  timestamp: z.string(),
  data: z.object({}).loose(),
})

/**
 * Verifies the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`)
 * on the raw body BEFORE parsing anything (AGENTS.md invariant 11), then maps the event. The event
 * id is the delivery's `webhook-id` (the same across retries). Throws InvalidSignature or
 * InvalidPayload.
 */
export const parsePolarWebhook: WebhookParser = async (rawBody, headers, secret) => {
  const signed: Record<string, string> = {}
  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature'])
    signed[name] = headers.get(name) ?? ''
  try {
    await webhooks.validateEvent(rawBody, signed, secret)
  } catch (e) {
    if (e instanceof webhooks.PolarWebhookVerificationError)
      throw new InvalidSignature('signature verification failed')
    // A verified event of a type this SDK version doesn't know is still recorded (below); only a
    // body that isn't JSON is invalid.
    if (!(e instanceof webhooks.PolarWebhookUnknownTypeError))
      throw new InvalidPayload('unparseable event')
  }
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    throw new InvalidPayload('unparseable event')
  }
  const event = eventSchema.safeParse(json)
  const eventId = id.safeParse(signed['webhook-id'])
  const createdAt = event.success ? new Date(event.data.timestamp) : null
  if (!event.success || !eventId.success || !createdAt || Number.isNaN(createdAt.getTime()))
    throw new InvalidPayload('unexpected event shape')
  const { type, data } = event.data
  const base = { provider: PROVIDER, eventId: eventId.data, type, createdAt }
  if (!type.startsWith('subscription.')) return { ...base, subscription: null }

  const sub = subscriptionSchema.safeParse(data)
  if (!sub.success) throw new InvalidPayload('unexpected subscription shape')
  return { ...base, subscription: snapshotOf(sub.data) }
}

function snapshotOf(s: z.infer<typeof subscriptionSchema>): ProviderEvent['subscription'] {
  const linked = s.metadata?.[ORGANIZATION_METADATA_KEY]
  const priceKey = s.product?.metadata?.[PRICE_KEY_METADATA_KEY]
  const periodEnd = s.current_period_end ? new Date(s.current_period_end) : null
  return {
    // ADR-0022: the checkout's metadata and the customer's external_id must agree; anything else
    // is recorded as unlinked and never applied.
    organizationId:
      typeof linked === 'string' && linked !== '' && linked === s.customer.external_id
        ? linked
        : null,
    providerCustomerId: s.customer_id,
    providerSubscriptionId: s.id,
    providerPriceId: s.product_id ?? null,
    priceKey: typeof priceKey === 'string' ? priceKey : null,
    // Unknown future statuses grant nothing (not an entitled status in the policy).
    status: STATUS[s.status] ?? 'incomplete',
    currentPeriodEnd: periodEnd && !Number.isNaN(periodEnd.getTime()) ? periodEnd : null,
    cancelAtPeriodEnd: s.cancel_at_period_end,
  }
}

type PolarClient = ReturnType<typeof createPolar>
const statusOf = (e: unknown) =>
  (e as { statusCode?: number })?.statusCode ?? (e as { status?: number })?.status

export type PolarConfig = {
  /** Worker secret POLAR_ACCESS_TOKEN: an organization access token. */
  accessToken: string
  /** Worker var POLAR_SERVER. */
  server: 'sandbox' | 'production'
}

export const polarClient = (config: PolarConfig): PolarClient =>
  createPolar({ accessToken: config.accessToken, environment: config.server })

/**
 * The organization's team customer, created if missing. Safe under retries and races: a losing
 * create reads the winner back by external id (eval run r1-0929: 8 concurrent calls, 1 customer).
 */
async function ensureCustomer(
  polar: PolarClient,
  org: { id: string; name: string },
  owner: { userId: string; email: string },
) {
  try {
    return await polar.customers.getExternal(org.id)
  } catch (e) {
    if (statusOf(e) !== 404) throw e
  }
  try {
    return await polar.customers.create({
      type: 'team',
      external_id: org.id,
      name: org.name,
      metadata: { [ORGANIZATION_METADATA_KEY]: org.id },
      owner: { email: owner.email, external_id: owner.userId },
    })
  } catch {
    return await polar.customers.getExternal(org.id)
  }
}

/**
 * Makes sure the caller (who holds `billing:manage`, checked by the service) is a member, adding
 * them as `billing_manager`: this repairs a grant the membership hooks couldn't make.
 */
async function ensureMember(
  polar: PolarClient,
  customerId: string,
  user: { userId: string; email: string },
) {
  const members = await polar.customers.members.list(customerId, {})
  if (members.items.some((m) => m.external_id === user.userId)) return
  await polar.customers.members.create(customerId, {
    email: user.email,
    external_id: user.userId,
    role: 'billing_manager',
  })
}

async function productFor(polar: PolarClient, priceKey: string) {
  const page = await polar.products.list({ is_archived: false, limit: 100 })
  const product = page.items.find((p) => p.metadata?.[PRICE_KEY_METADATA_KEY] === priceKey)
  if (!product) throw new PriceNotFound(`no active product with price_key ${priceKey}`)
  return product
}

/** Polar behind the provider interface. Tax: Polar is merchant of record (ADR-0022). */
export function polarProvider(config: PolarConfig): BillingProvider {
  const polar = polarClient(config)
  return {
    async checkout(req: CheckoutRequest) {
      const user = { userId: req.userId, email: req.customerEmail }
      const customer = await ensureCustomer(
        polar,
        { id: req.organizationId, name: req.organizationName },
        user,
      )
      await ensureMember(polar, customer.id, user)
      const product = await productFor(polar, req.priceKey)
      const checkout = await polar.checkouts.create({
        products: [product.id],
        customer_id: customer.id,
        // Copied onto the subscription; the webhook links through it (with the customer's id).
        metadata: { [ORGANIZATION_METADATA_KEY]: req.organizationId },
        success_url: req.successUrl,
        allow_trial: req.trialDays > 0,
        ...(req.trialDays > 0 && {
          trial_interval: 'day' as const,
          trial_interval_count: req.trialDays,
        }),
      })
      return checkout.url
    },
    async portal(req: PortalRequest) {
      await ensureMember(polar, req.customerId, {
        userId: req.userId,
        email: req.customerEmail,
      })
      const session = await polar.customerSessions.create({
        customer_id: req.customerId,
        external_member_id: req.userId,
        return_url: req.returnUrl,
      })
      return session.customer_portal_url
    },
  }
}

async function customerOf(polar: PolarClient, organizationId: string) {
  try {
    return await polar.customers.getExternal(organizationId)
  } catch (e) {
    if (statusOf(e) === 404) return null
    throw e
  }
}

export class NoSuccessor extends Error {
  name = 'NoSuccessor'
}

/**
 * Member sync for ADR-0022's "revoke before, grant after". Polar refuses to delete a customer's only
 * owner (run r2-0929), so revoking the Polar owner first promotes a successor.
 */
export function polarMembers(config: PolarConfig): BillingMembers {
  const polar = polarClient(config)
  return {
    async revoke(organizationId, userId, successors) {
      const customer = await customerOf(polar, organizationId)
      if (!customer) return
      const members = (await polar.customers.members.list(customer.id, {})).items
      const target = members.find((m) => m.external_id === userId)
      if (!target) return
      if (target.role === 'owner') {
        const next = successors.find((s) => s.userId !== userId)
        if (!next) throw new NoSuccessor('no remaining billing manager to own the account')
        const existing = members.find((m) => m.external_id === next.userId)
        const successor =
          existing ??
          (await polar.customers.members.create(customer.id, {
            email: next.email,
            external_id: next.userId,
            role: 'billing_manager',
          }))
        await polar.customers.members.update(customer.id, successor.id, { role: 'owner' })
      }
      await polar.customers.members.delete(customer.id, target.id)
    },
    async grant(organizationId, manager: BillingManager) {
      const customer = await customerOf(polar, organizationId)
      if (customer) await ensureMember(polar, customer.id, manager)
    },
    async removeAccount(organizationId) {
      const customer = await customerOf(polar, organizationId)
      if (customer) await polar.customers.delete(customer.id)
    },
  }
}
