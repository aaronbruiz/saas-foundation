import { eq, lte, sql } from 'drizzle-orm'
import type { Db } from './client.ts'
import { organization } from './schema/auth.ts'
import {
  billingSubscription,
  billingWebhookEvent,
  type BillingSubscription,
  type SubscriptionStatus,
} from './schema/billing.ts'
import type { TenantScope } from './tenancy.ts'

/** A provider's subscription, already verified and mapped to our model by the provider adapter. */
export type SubscriptionSnapshot = {
  /** From the provider object's metadata, set by our own checkout; checked to exist here. */
  organizationId: string | null
  providerCustomerId: string
  providerSubscriptionId: string
  providerPriceId: string | null
  status: SubscriptionStatus
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
}

export type BillingEvent = {
  provider: string
  eventId: string
  type: string
  createdAt: Date
  /** Present when the event carries a subscription; other events are only recorded. */
  subscription: SubscriptionSnapshot | null
}

export type BillingEventOutcome = 'duplicate' | 'ignored' | 'unlinked' | 'stale' | 'applied'

const TERMINAL: SubscriptionStatus[] = ['canceled']

/**
 * Applies one verified webhook event exactly once (AGENTS.md invariant 11). The dedupe record and
 * the state change commit together, so a failure leaves nothing behind and the provider's retry
 * is processed normally. Concurrent deliveries of the same event serialize on the primary key.
 */
export async function applyBillingEvent(db: Db, event: BillingEvent): Promise<BillingEventOutcome> {
  return db.transaction(async (tx) => {
    const recorded = await tx
      .insert(billingWebhookEvent)
      .values({ provider: event.provider, eventId: event.eventId, type: event.type })
      .onConflictDoNothing()
      .returning({ eventId: billingWebhookEvent.eventId })
    if (recorded.length === 0) return 'duplicate'

    const sub = event.subscription
    if (!sub) return 'ignored'
    if (!sub.organizationId) return 'unlinked'
    const [org] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, sub.organizationId))
      .limit(1)
    if (!org) return 'unlinked'

    const [current] = await tx
      .select()
      .from(billingSubscription)
      .where(eq(billingSubscription.organizationId, org.id))
      .for('update')
    // A replaced subscription ending must not overwrite the organization's current one.
    if (
      current &&
      current.providerSubscriptionId !== sub.providerSubscriptionId &&
      TERMINAL.includes(sub.status)
    )
      return 'stale'

    const values = {
      provider: event.provider,
      providerCustomerId: sub.providerCustomerId,
      providerSubscriptionId: sub.providerSubscriptionId,
      providerPriceId: sub.providerPriceId,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      providerEventAt: event.createdAt,
    }
    // Events can arrive out of order: only an event at least as new as the stored one applies.
    const written = await tx
      .insert(billingSubscription)
      .values({ organizationId: org.id, ...values })
      .onConflictDoUpdate({
        target: billingSubscription.organizationId,
        set: { ...values, updatedAt: sql`now()` },
        setWhere: lte(billingSubscription.providerEventAt, event.createdAt),
      })
      .returning({ organizationId: billingSubscription.organizationId })
    return written.length > 0 ? 'applied' : 'stale'
  })
}

/** Tenant-scoped read of the organization's billing state (AGENTS.md invariant 2). */
export function billing(db: Db, scope: TenantScope) {
  return {
    subscription: async (): Promise<BillingSubscription | null> =>
      (
        await db
          .select()
          .from(billingSubscription)
          .where(eq(billingSubscription.organizationId, scope.orgId))
          .limit(1)
      )[0] ?? null,
  }
}
