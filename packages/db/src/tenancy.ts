import { and, count, desc, eq } from 'drizzle-orm'
import { rawDb, type Db } from './client.ts'
import { member, organization, user } from './schema/auth.ts'
import { billingSubscription, type BillingSubscription } from './schema/billing.ts'
import { project, type Project } from './schema/projects.ts'
import { inTenant } from './tenant-transaction.ts'

/** Tenant context resolved server-side by the app (AGENTS.md invariant 1). */
export type TenantScope = { orgId: string }

export async function findOrganizationBySlug(db: Db, slug: string) {
  const [org] = await rawDb(db)
    .select({ id: organization.id, slug: organization.slug, name: organization.name })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1)
  return org ?? null
}

export async function findOrganizationById(db: Db, id: string) {
  const [org] = await rawDb(db)
    .select({ id: organization.id, slug: organization.slug, name: organization.name })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  return org ?? null
}

/** Members of an organization (for plan limits; Better Auth enforces the member limit itself). */
export async function countMembers(db: Db, orgId: string): Promise<number> {
  const [row] = await rawDb(db)
    .select({ n: count() })
    .from(member)
    .where(eq(member.organizationId, orgId))
  return row?.n ?? 0
}

export async function findMembership(db: Db, orgId: string, userId: string) {
  const [m] = await rawDb(db)
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  return m ?? null
}

/**
 * Members holding the `owner` role (billing:manage; ADR-0022 mirrors them as provider members). A
 * role may list several comma-separated roles (Better Auth), read like the capability matrix does.
 */
export async function listOwners(
  db: Db,
  orgId: string,
): Promise<{ userId: string; email: string }[]> {
  const rows = await rawDb(db)
    .select({ userId: member.userId, email: user.email, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId))
  return rows
    .filter((r) => r.role.split(',').some((x) => x.trim() === 'owner'))
    .map(({ userId, email }) => ({ userId, email }))
}

export type ProjectFields = { name: string; description?: string | null }

/**
 * The only way to touch project rows (AGENTS.md invariant 2). Every statement is scoped by
 * `scope.orgId` and runs in its own tenant transaction (ADR-0040); organizationId is never taken
 * from input. Missing or foreign rows → null.
 */
export function projects(db: Db, scope: TenantScope) {
  const inScope = (id: string) => and(eq(project.id, id), eq(project.organizationId, scope.orgId))
  return {
    // async: hand back rows, never the query builder (it carries the raw client).
    list: (): Promise<Project[]> =>
      inTenant(db, scope, (tx) =>
        tx
          .select()
          .from(project)
          .where(eq(project.organizationId, scope.orgId))
          .orderBy(desc(project.createdAt)),
      ),
    get: (id: string): Promise<Project | null> =>
      inTenant(
        db,
        scope,
        async (tx) => (await tx.select().from(project).where(inScope(id)).limit(1))[0] ?? null,
      ),
    count: (): Promise<number> =>
      inTenant(
        db,
        scope,
        async (tx) =>
          (
            await tx
              .select({ n: count() })
              .from(project)
              .where(eq(project.organizationId, scope.orgId))
          )[0]?.n ?? 0,
      ),
    /**
     * Creates a project unless the tenant already has the limit `limitFor` gives for its
     * subscription (null = unlimited). Creations for one tenant serialize on its organization row,
     * so concurrent requests can't overshoot the limit. The subscription is read in the same
     * transaction, after the lock, to save a tenant transaction (ADR-0040 decision 8). Returns null
     * at the limit.
     */
    createWithinLimit: (
      fields: ProjectFields,
      createdBy: string,
      limitFor: (subscription: BillingSubscription | null) => number | null,
    ) =>
      inTenant(db, scope, async (tx): Promise<Project | null> => {
        await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, scope.orgId))
          .for('no key update')
        const [subscription] = await tx
          .select()
          .from(billingSubscription)
          .where(eq(billingSubscription.organizationId, scope.orgId))
          .limit(1)
        const limit = limitFor(subscription ?? null)
        if (limit !== null) {
          const [row] = await tx
            .select({ n: count() })
            .from(project)
            .where(eq(project.organizationId, scope.orgId))
          if ((row?.n ?? 0) >= limit) return null
        }
        const [created] = await tx
          .insert(project)
          .values({ ...fields, organizationId: scope.orgId, createdBy })
          .returning()
        if (!created) throw new Error('insert returned no row')
        return created
      }),
    update: (id: string, fields: Partial<ProjectFields>): Promise<Project | null> =>
      inTenant(
        db,
        scope,
        async (tx) =>
          (await tx.update(project).set(fields).where(inScope(id)).returning())[0] ?? null,
      ),
    remove: (id: string): Promise<boolean> =>
      inTenant(
        db,
        scope,
        async (tx) =>
          (await tx.delete(project).where(inScope(id)).returning({ id: project.id })).length > 0,
      ),
  }
}
