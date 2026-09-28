import { notFound, redirect } from '@tanstack/react-router'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { HttpError } from './errors'

/** Request headers for services, from the TanStack server-function request. */
export const requestHeaders = () => new Headers(getRequestHeaders() as HeadersInit)

/**
 * Runs a service for a server function and maps HTTP errors for the router: 404 → notFound()
 * (the same not-found UI for unknown and foreign tenants), 401 → /login.
 */
export async function serve<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw notFound()
    if (e instanceof HttpError && e.status === 401)
      throw redirect({ to: '/login', search: { redirect: '/' } })
    throw e
  }
}
