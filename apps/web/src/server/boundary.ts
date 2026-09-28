import { notFound, redirect } from '@tanstack/react-router'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { HttpError } from './errors'
import { logUnexpected } from './log'

/** Request headers for services, from the TanStack server-function request. */
export const requestHeaders = () => new Headers(getRequestHeaders() as HeadersInit)

/**
 * Cloudflare's per-request id (`cf-ray`): the correlation id in our logs, matching Cloudflare's own
 * request logs and error pages. Absent locally; undefined outside a request.
 */
export function rayId(): string | undefined {
  try {
    return new Headers(getRequestHeaders() as HeadersInit).get('cf-ray') ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Runs a service for a server function and maps HTTP errors for the router: 404 → notFound()
 * (the same not-found UI for unknown and foreign tenants), 401 → /login. Anything unexpected is
 * logged (ADR-0015) before it propagates: the framework turns it into an error response, so Workers
 * Logs wouldn't record it as an exception otherwise.
 */
export async function serve<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw notFound()
    if (e instanceof HttpError && e.status === 401)
      throw redirect({ to: '/login', search: { redirect: '/' } })
    logUnexpected('server_fn.unhandled', e, { rayId: rayId() })
    throw e
  }
}
