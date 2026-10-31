import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'

// ADR-0044: the record that an account was deactivated. No foreign key: it outlives the purge, so
// a restore can tell which accounts must not come back. Holds only the id and times.
export const userDeletion = pgTable('user_deletion', {
  userId: text('user_id').primaryKey(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
  purgedAt: timestamp('purged_at', { withTimezone: true }),
})

// ADR-0044: orders writes of this user into the billing provider against their account's deletion,
// with no clock: what a request can't know for sure about the provider stays counted until someone
// resolves it. Created on first use.
export const billingAccessGate = pgTable('billing_access_gate', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  // Writes whose outcome at the provider isn't known yet.
  writesInFlight: integer('writes_in_flight').notNull().default(0),
  // The deletion attempt holding the gate closed; no write starts while it's set.
  closedBy: text('closed_by'),
  // Set by the transaction that deactivates the account; nothing changes the gate after it.
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
})
