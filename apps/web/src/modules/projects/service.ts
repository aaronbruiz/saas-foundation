import { projects, type Project } from '@saas-foundation/db'
import {
  CreateProjectInput,
  ProjectRef,
  TenantInput,
  UpdateProjectInput,
} from '@saas-foundation/contracts'
import { getTenantContext } from '../../server/context'
import { withDb } from '../../server/db'
import { notFound, parseInput } from '../../server/errors'

// Plain functions (testable in workerd); server functions in ./functions.ts only adapt them.
// Every member of the tenant may CRUD projects (Vertical Slice 001 permissions).

export async function listProjects(headers: Headers, input: unknown): Promise<Project[]> {
  const { tenant } = parseInput(TenantInput, input)
  return withDb(async (db) => projects(db, await getTenantContext(db, headers, tenant)).list())
}

export async function getProject(headers: Headers, input: unknown): Promise<Project> {
  const { tenant, id } = parseInput(ProjectRef, input)
  return withDb(async (db) => {
    const row = await projects(db, await getTenantContext(db, headers, tenant)).get(id)
    if (!row) throw notFound()
    return row
  })
}

export async function createProject(headers: Headers, input: unknown): Promise<Project> {
  const { tenant, project } = parseInput(CreateProjectInput, input)
  return withDb(async (db) => {
    const ctx = await getTenantContext(db, headers, tenant)
    return projects(db, ctx).create(project, ctx.userId)
  })
}

export async function updateProject(headers: Headers, input: unknown): Promise<Project> {
  const { tenant, id, project } = parseInput(UpdateProjectInput, input)
  return withDb(async (db) => {
    const row = await projects(db, await getTenantContext(db, headers, tenant)).update(id, project)
    if (!row) throw notFound()
    return row
  })
}

export async function deleteProject(headers: Headers, input: unknown): Promise<{ id: string }> {
  const { tenant, id } = parseInput(ProjectRef, input)
  return withDb(async (db) => {
    if (!(await projects(db, await getTenantContext(db, headers, tenant)).remove(id)))
      throw notFound()
    return { id }
  })
}
