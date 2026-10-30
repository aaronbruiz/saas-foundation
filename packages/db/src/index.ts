// Drizzle schema, migrations, client factory and tenant-scoped repositories.
// The only way to touch tenant data (AGENTS.md invariant 2). Imports no workspace package.
export {
  applyBillingEvent,
  isBillingEventRecorded,
  billing,
  type BillingEvent,
  type BillingEventOutcome,
  type SubscriptionSnapshot,
} from './billing.ts'
export { createDb, type Db } from './client.ts'
export { currentDatabase, ping } from './health.ts'
export {
  cancelPendingInvitation,
  findMember,
  removeNonOwnerMember,
  updateNonOwnerMemberRole,
  countMembers,
  findMembership,
  findPendingInvitation,
  findOrganizationById,
  findOrganizationBySlug,
  listMembers,
  listOwners,
  listPendingInvitations,
  projects,
  type PendingInvitation,
  type ProjectFields,
  type TenantScope,
} from './tenancy.ts'
export type { BillingSubscription, SubscriptionStatus } from './schema/billing.ts'
export type { Project } from './schema/projects.ts'
