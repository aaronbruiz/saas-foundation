import { and, desc, eq } from 'drizzle-orm'
import type { Db } from './client.ts'
import { member, organization } from './schema/auth.ts'
import { project, type Project } from './schema/projects.ts'

/** Tenant context resolved server-side by the app (AGENTS.md invariant 1). */
export type TenantScope = { orgId: string }

export async function findOrganizationBySlug(db: Db, slug: string) {
  const [org] = await db
    .select({ id: organization.id, slug: organization.slug, name: organization.name })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1)
  return org ?? null
}

export async function findOrganizationById(db: Db, id: string) {
  const [org] = await db
    .select({ id: organization.id, slug: organization.slug, name: organization.name })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  return org ?? null
}

export async function findMembership(db: Db, orgId: string, userId: string) {
  const [m] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  return m ?? null
}

export type ProjectFields = { name: string; description?: string | null }

/**
 * The only way to touch project rows (AGENTS.md invariant 2). Every statement is scoped by
 * `scope.orgId`; organizationId is never taken from input. Missing or foreign rows → null.
 */
export function projects(db: Db, scope: TenantScope) {
  const inTenant = (id: string) => and(eq(project.id, id), eq(project.organizationId, scope.orgId))
  return {
    list: (): Promise<Project[]> =>
      db
        .select()
        .from(project)
        .where(eq(project.organizationId, scope.orgId))
        .orderBy(desc(project.createdAt)),
    get: async (id: string): Promise<Project | null> =>
      (await db.select().from(project).where(inTenant(id)).limit(1))[0] ?? null,
    create: async (fields: ProjectFields, createdBy: string): Promise<Project> => {
      const [row] = await db
        .insert(project)
        .values({ ...fields, organizationId: scope.orgId, createdBy })
        .returning()
      if (!row) throw new Error('insert returned no row')
      return row
    },
    update: async (id: string, fields: Partial<ProjectFields>): Promise<Project | null> =>
      (await db.update(project).set(fields).where(inTenant(id)).returning())[0] ?? null,
    remove: async (id: string): Promise<boolean> =>
      (await db.delete(project).where(inTenant(id)).returning({ id: project.id })).length > 0,
  }
}
