import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { isUnknownServerFnError, isUnknownServerFnPath } from './server/unknown-server-fn'

// TanStack's own default, which a start instance replaces: server functions refuse cross-origin
// requests (403). Keep it first.
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

// Global request middleware: runs for server routes, SSR and server functions.
export const startInstance = createStart(() => ({
  requestMiddleware: [csrf, unknownServerFnAs404],
}))
