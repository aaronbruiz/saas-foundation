import { projects, type Db, type Project } from '@saas-foundation/db'
import {
  CreateProjectInput,
  ProjectRef,
  TenantInput,
  UpdateProjectInput,
} from '@saas-foundation/contracts'
import { getTenantContext } from '../../server/context'
import { withDb } from '../../server/db'
import { HttpError, notFound, parseInput } from '../../server/errors'
import { authorize, type Capability } from '../../server/permissions'
import { entitlementsIn } from '../billing/entitlements'

// Plain functions (testable in workerd); server functions in ./functions.ts only adapt them.
// Role checks come from the capability matrix (server/permissions.ts).

/**
 * Tenant boundary (404 outside the tenant), then the role check (403 inside it). With `id`, the
 * project must exist in this tenant before the role check, so another tenant's project id is a 404
 * even for a role that lacks the capability (AGENTS.md invariant 5).
 */
async function scoped(
  db: Db,
  headers: Headers,
  tenant: string,
  capability: Capability,
  id?: string,
) {
  const ctx = await getTenantContext(db, headers, tenant)
  const repo = projects(db, ctx)
  if (id !== undefined && !(await repo.get(id))) throw notFound()
  authorize(ctx, capability)
  return { ctx, repo }
}

export async function listProjects(headers: Headers, input: unknown): Promise<Project[]> {
  const { tenant } = parseInput(TenantInput, input)
  return withDb(async (db) => (await scoped(db, headers, tenant, 'project:read')).repo.list())
}

export async function getProject(headers: Headers, input: unknown): Promise<Project> {
  const { tenant, id } = parseInput(ProjectRef, input)
  return withDb(async (db) => {
    const row = await (await scoped(db, headers, tenant, 'project:read')).repo.get(id)
    if (!row) throw notFound()
    return row
  })
}

export async function createProject(headers: Headers, input: unknown): Promise<Project> {
  const { tenant, project } = parseInput(CreateProjectInput, input)
  return withDb(async (db) => {
    const { ctx, repo } = await scoped(db, headers, tenant, 'project:create')
    // Plan limit (ADR-0020): a hard stop for new projects; existing ones are never touched.
    const { limits } = await entitlementsIn(db, ctx.orgId)
    const created = await repo.createWithinLimit(project, ctx.userId, limits.projects)
    if (!created)
      throw new HttpError(403, `Your plan allows ${limits.projects} projects. Upgrade to add more.`)
    return created
  })
}

export async function updateProject(headers: Headers, input: unknown): Promise<Project> {
  const { tenant, id, project } = parseInput(UpdateProjectInput, input)
  return withDb(async (db) => {
    const row = await (
      await scoped(db, headers, tenant, 'project:update', id)
    ).repo.update(id, project)
    if (!row) throw notFound()
    return row
  })
}

export async function deleteProject(headers: Headers, input: unknown): Promise<{ id: string }> {
  const { tenant, id } = parseInput(ProjectRef, input)
  return withDb(async (db) => {
    if (!(await (await scoped(db, headers, tenant, 'project:delete', id)).repo.remove(id)))
      throw notFound()
    return { id }
  })
}
