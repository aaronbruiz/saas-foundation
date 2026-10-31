import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { rawDb, type Db } from './client.ts'
import { organization } from './schema/auth.ts'
import {
  billingCheckoutGate,
  billingSubscription,
  billingWebhookEvent,
  type BillingSubscription,
  type SubscriptionStatus,
} from './schema/billing.ts'
import type { TenantScope } from './tenancy.ts'
import { enterTenant, inTenant, ownTransaction } from './tenant-transaction.ts'

/** A provider's subscription, already verified and mapped to our model by the provider adapter. */
export type SubscriptionSnapshot = {
  /** From the provider object's metadata, set by our own checkout; checked to exist here. */
  organizationId: string | null
  providerCustomerId: string
  providerSubscriptionId: string
  providerPriceId: string | null
  /** Our plan for that price (the app's product policy decides); null for a price we don't sell. */
  planKey: string | null
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

export type BillingEventOutcome =
  | 'duplicate'
  | 'ignored'
  | 'unlinked'
  | 'conflict'
  | 'stale'
  | 'applied'

const TERMINAL: SubscriptionStatus[] = ['canceled']

/**
 * Applies one verified webhook event exactly once (AGENTS.md invariant 11, ADR-0018). The dedupe
 * record and the state change commit together, so a failure leaves nothing behind and the
 * provider's retry is processed normally. Concurrent deliveries of the same event serialize on the
 * dedupe key; all events for one organization serialize on its row lock. Every outcome except a
 * database error is final (the delivery is acknowledged), so no verified event can loop forever.
 */
export async function applyBillingEvent(db: Db, event: BillingEvent): Promise<BillingEventOutcome> {
  return ownTransaction(db, async (tx) => {
    const recorded = await tx
      .insert(billingWebhookEvent)
      .values({ provider: event.provider, eventId: event.eventId, type: event.type })
      .onConflictDoNothing()
      .returning({ eventId: billingWebhookEvent.eventId })
    if (recorded.length === 0) return 'duplicate'

    const sub = event.subscription
    if (!sub) return 'ignored'
    if (!sub.organizationId) return 'unlinked'
    // Locks the organization (not the billing row, which may not exist yet), so events for it apply
    // one at a time. NO KEY UPDATE still lets rows referencing it be inserted.
    const [org] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, sub.organizationId))
      .for('no key update')
    if (!org) return 'unlinked'
    await enterTenant(tx, org.id)

    // A subscription belongs to the organization it was first linked to; moving it is not supported.
    // The one cross-tenant read on a tenant table (ADR-0040's reviewed webhook bypass): an
    // owner-owned definer function that answers only yes or no, for the tenant just entered.
    const { rows } = await tx.execute<{ held: boolean }>(
      sql`select public.billing_subscription_held_elsewhere(${event.provider}, ${sub.providerSubscriptionId}) as held`,
    )
    const held = rows[0]?.held
    if (held === true) return 'conflict'
    if (held !== false) throw new Error('subscription holder check gave no answer')

    const [current] = await tx
      .select()
      .from(billingSubscription)
      .where(eq(billingSubscription.organizationId, org.id))
    if (current && !supersedes(event, sub, current)) return 'stale'

    const values = {
      provider: event.provider,
      providerCustomerId: sub.providerCustomerId,
      providerSubscriptionId: sub.providerSubscriptionId,
      providerPriceId: sub.providerPriceId,
      planKey: sub.planKey,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      providerEventAt: event.createdAt,
    }
    await tx
      .insert(billingSubscription)
      .values({ organizationId: org.id, ...values })
      .onConflictDoUpdate({
        target: billingSubscription.organizationId,
        set: { ...values, updatedAt: sql`now()` },
      })
    return 'applied'
  })
}

/** True once a provider's webhook event has been recorded (applied or not) by applyBillingEvent. */
export async function isBillingEventRecorded(db: Db, provider: string, eventId: string) {
  const [row] = await rawDb(db)
    .select({ eventId: billingWebhookEvent.eventId })
    .from(billingWebhookEvent)
    .where(
      and(eq(billingWebhookEvent.provider, provider), eq(billingWebhookEvent.eventId, eventId)),
    )
    .limit(1)
  return row !== undefined
}

/**
 * Ordering is per subscription: for the stored one, an event at least as new applies (provider
 * timestamps have one-second resolution, so same-second events apply in arrival order; ADR-0018).
 * Another subscription never applies a cancellation, replaces a canceled one whenever it arrives,
 * and replaces a live one only if newer.
 */
function supersedes(
  event: BillingEvent,
  incoming: SubscriptionSnapshot,
  current: BillingSubscription,
) {
  const at = event.createdAt
  const same =
    event.provider === current.provider &&
    incoming.providerSubscriptionId === current.providerSubscriptionId
  if (same) return at >= current.providerEventAt
  if (TERMINAL.includes(incoming.status)) return false
  return TERMINAL.includes(current.status) || at > current.providerEventAt
}

/** Tenant-scoped read of the organization's billing state (AGENTS.md invariant 2, ADR-0040). */
export function billing(db: Db, scope: TenantScope) {
  return {
    /**
     * Before anything reaches the provider: counts the attempt, unless a deletion has committed
     * (false). ADR-0043: one conditional upsert, so the condition holds in the write.
     */
    startCheckoutAttempt: (): Promise<boolean> =>
      inTenant(db, scope, async (tx) => {
        const gate = billingCheckoutGate
        const rows = await tx
          .insert(gate)
          .values({ organizationId: scope.orgId, checkoutGeneration: 1, checkoutsInFlight: 1 })
          .onConflictDoUpdate({
            target: gate.organizationId,
            set: {
              checkoutGeneration: sql`${gate.checkoutGeneration} + 1`,
              checkoutsInFlight: sql`${gate.checkoutsInFlight} + 1`,
            },
            where: isNull(gate.removalStartedAt),
          })
          .returning({ organizationId: gate.organizationId })
        return rows.length > 0
      }),
    /** The attempt's outcome is known: its session exists, or it can never exist. */
    finishCheckoutAttempt: (): Promise<void> =>
      inTenant(db, scope, async (tx) => {
        const gate = billingCheckoutGate
        await tx
          .update(gate)
          .set({ checkoutsInFlight: sql`${gate.checkoutsInFlight} - 1` })
          .where(and(eq(gate.organizationId, scope.orgId), gt(gate.checkoutsInFlight, 0)))
      }),
    /** Read before the provider: `commitRemoval` then proves nothing started since. */
    deletionGate: () =>
      inTenant(db, scope, async (tx) => {
        const [row] = await tx
          .select()
          .from(billingCheckoutGate)
          .where(eq(billingCheckoutGate.organizationId, scope.orgId))
        return {
          generation: row?.checkoutGeneration ?? 0,
          checkoutsInFlight: row?.checkoutsInFlight ?? 0,
          removalStarted: !!row?.removalStartedAt,
        }
      }),
    /**
     * Closes checkouts for good, if none started since `generation` was read and none is in flight
     * (false otherwise). A stalled request can't get past this however long it took to arrive.
     */
    commitRemoval: (generation: number): Promise<boolean> =>
      inTenant(db, scope, async (tx) => {
        const gate = billingCheckoutGate
        const rows = await tx
          .insert(gate)
          .values({ organizationId: scope.orgId, removalStartedAt: sql`now()` })
          .onConflictDoUpdate({
            target: gate.organizationId,
            set: { removalStartedAt: sql`now()` },
            where: and(eq(gate.checkoutGeneration, generation), eq(gate.checkoutsInFlight, 0)),
          })
          .returning({ organizationId: gate.organizationId })
        return rows.length > 0
      }),
    subscription: (): Promise<BillingSubscription | null> =>
      inTenant(
        db,
        scope,
        async (tx) =>
          (
            await tx
              .select()
              .from(billingSubscription)
              .where(eq(billingSubscription.organizationId, scope.orgId))
              .limit(1)
          )[0] ?? null,
      ),
  }
}
