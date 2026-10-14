import { createServerFn } from '@tanstack/react-start'
import {
  CreateProjectInput,
  ProjectRef,
  TenantInput,
  UpdateProjectInput,
} from '@saas-foundation/contracts'
import { requestHeaders, serve } from '../../server/boundary'
import { validateWith } from '../../server/validate'
import { createProject, deleteProject, getProject, listProjects, updateProject } from './service'

// Thin adapters: server functions aren't served under /t/<slug>, so every call carries `tenant`
// as validated input and the service re-verifies membership (ADR-0010).
export const listProjectsFn = createServerFn({ method: 'GET' })
  .validator(validateWith(TenantInput))
  .handler(({ data }) => serve(() => listProjects(requestHeaders(), data)))
export const getProjectFn = createServerFn({ method: 'GET' })
  .validator(validateWith(ProjectRef))
  .handler(({ data }) => serve(() => getProject(requestHeaders(), data)))
export const createProjectFn = createServerFn({ method: 'POST' })
  .validator(validateWith(CreateProjectInput))
  .handler(({ data }) => serve(() => createProject(requestHeaders(), data)))
export const updateProjectFn = createServerFn({ method: 'POST' })
  .validator(validateWith(UpdateProjectInput))
  .handler(({ data }) => serve(() => updateProject(requestHeaders(), data)))
export const deleteProjectFn = createServerFn({ method: 'POST' })
  .validator(validateWith(ProjectRef))
  .handler(({ data }) => serve(() => deleteProject(requestHeaders(), data)))
