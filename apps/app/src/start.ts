import { createMiddleware, createStart } from '@tanstack/react-start'
import { isUnknownServerFnError } from './server/unknown-server-fn'

// An unknown server-function id gets a plain 404, like any unknown path, instead of a logged 500.
// Every other error propagates unchanged.
const unknownServerFnAs404 = createMiddleware().server(async ({ next, handlerType }) => {
  if (handlerType !== 'serverFn') return next()
  try {
    return await next()
  } catch (e) {
    if (isUnknownServerFnError(e)) return new Response('Not Found', { status: 404 })
    throw e
  }
})

// Global request middleware: runs for server routes, SSR and server functions.
export const startInstance = createStart(() => ({ requestMiddleware: [unknownServerFnAs404] }))
