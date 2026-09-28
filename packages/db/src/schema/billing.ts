import { boolean, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { organization } from './auth.ts'

// ADR-0018. Billing state is owned by the organization (one subscription per organization) and
// written only by verified provider webhooks. Authorization never reads it directly: it goes
// through entitlements (AGENTS.md invariant 6).
export const billingSubscription = pgTable('billing_subscription', {
  // One row per organization: the primary key is also the tenant key (AGENTS.md recipe).
  // RESTRICT: deleting an organization with billing state is an open product decision (ADR-0018),
  // so the database refuses it instead of silently dropping the record.
  organizationId: text('organization_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'restrict' }),
  provider: text('provider').notNull(),
  providerCustomerId: text('provider_customer_id').notNull(),
  providerSubscriptionId: text('provider_subscription_id').notNull().unique(),
  providerPriceId: text('provider_price_id'),
  // Our plan key; null until the plan catalog exists (a product decision).
  planKey: text('plan_key'),
  status: text('status').$type<SubscriptionStatus>().notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  // Creation time of the provider event this row reflects; older events never overwrite it.
  providerEventAt: timestamp('provider_event_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

// Dedupe log for webhook deliveries (AGENTS.md invariant 11). Not tenant data.
export const billingWebhookEvent = pgTable(
  'billing_webhook_event',
  {
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
)

/** Internal, provider-neutral subscription status (ADR-0009). */
export type SubscriptionStatus =
  'active' | 'trialing' | 'past_due' | 'unpaid' | 'paused' | 'incomplete' | 'canceled'

export type BillingSubscription = typeof billingSubscription.$inferSelect
