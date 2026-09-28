import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { createProject, deleteProject, getProject, listProjects, updateProject } from './service'

// Thin adapters: server functions aren't served under /t/<slug>, so every call carries `tenant`
// as validated input and the service re-verifies membership (ADR-0010).
const headers = () => new Headers(getRequestHeaders() as HeadersInit)
const passthrough = (data: unknown) => data

export const listProjectsFn = createServerFn({ method: 'GET' })
  .inputValidator(passthrough)
  .handler(({ data }) => listProjects(headers(), data))
export const getProjectFn = createServerFn({ method: 'GET' })
  .inputValidator(passthrough)
  .handler(({ data }) => getProject(headers(), data))
export const createProjectFn = createServerFn({ method: 'POST' })
  .inputValidator(passthrough)
  .handler(({ data }) => createProject(headers(), data))
export const updateProjectFn = createServerFn({ method: 'POST' })
  .inputValidator(passthrough)
  .handler(({ data }) => updateProject(headers(), data))
export const deleteProjectFn = createServerFn({ method: 'POST' })
  .inputValidator(passthrough)
  .handler(({ data }) => deleteProject(headers(), data))
