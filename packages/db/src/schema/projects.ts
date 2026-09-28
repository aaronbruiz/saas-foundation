import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { organization, user } from './auth.ts'

// First tenant-owned table (AGENTS.md recipe): organization_id NOT NULL + FK + index leading with it.
export const project = pgTable(
  'project',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('project_organization_id_created_at_idx').on(t.organizationId, t.createdAt)],
)

export type Project = typeof project.$inferSelect
