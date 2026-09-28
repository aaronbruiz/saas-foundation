import { boolean, pgTable, primaryKey, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { organization } from './auth.ts'

// ADR-0018. Billing state is owned by the organization (one subscription per organization) and
// written only by verified provider webhooks. Authorization never reads it directly: it goes
// through entitlements (AGENTS.md invariant 6).
export const billingSubscription = pgTable(
  'billing_subscription',
  {
    // One row per organization: the primary key is also the tenant key (AGENTS.md recipe).
    // CASCADE (ADR-0020): the app refuses to delete an organization whose subscription is still
    // live; an ended subscription's record goes with the organization.
    organizationId: text('organization_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerCustomerId: text('provider_customer_id').notNull(),
    providerSubscriptionId: text('provider_subscription_id').notNull(),
    providerPriceId: text('provider_price_id'),
    // Our plan key, resolved from the price by the app's product policy (ADR-0020); null for a
    // price the product doesn't sell.
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
  },
  // Provider ids are only unique within their provider.
  (t) => [
    unique('billing_subscription_provider_subscription_unique').on(
      t.provider,
      t.providerSubscriptionId,
    ),
  ],
)

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
