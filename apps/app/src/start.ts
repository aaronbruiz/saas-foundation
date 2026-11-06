import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { newNonce, setSecurityHeaders } from './server/security-headers'
import { isUnknownServerFnError, isUnknownServerFnPath } from './server/unknown-server-fn'

// TanStack's own default, which a start instance replaces: server functions refuse cross-origin
// requests (403). Keep it before any middleware that handles the request.
const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })

// An unknown server-function id gets a plain 404, like any unknown path, instead of a logged 500.
// Every other error propagates unchanged.
const unknownServerFnAs404 = createMiddleware().server(async ({ next, handlerType, pathname }) => {
  if (handlerType !== 'serverFn') return next()
  if (isUnknownServerFnPath(pathname)) return new Response('Not Found', { status: 404 })
  try {
    return await next()
  } catch (e) {
    if (isUnknownServerFnError(e)) return new Response('Not Found', { status: 404 })
    throw e
  }
})

// ADR-0045: outermost, so the CSRF 403 and the 404 above get the headers too. The nonce reaches the
// router through the global context (router.tsx).
const securityHeaders = createMiddleware().server(async ({ next }) => {
  const nonce = newNonce()
  const result = await next({ context: { nonce } })
  setSecurityHeaders(result.response.headers, nonce, import.meta.env.DEV)
  return result
})

// Global request middleware: runs for server routes, SSR and server functions, `/api/ping` included,
// so keep it free of database work (the uptime monitor polls that route; ADR-0031 note).
export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders, csrf, unknownServerFnAs404],
}))
