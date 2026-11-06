import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { getGlobalStartContext } from '@tanstack/react-start'
import { ErrorPage } from './lib/error-page'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: ErrorPage,
    // ADR-0045: the request's CSP nonce (server.ts) on the SSR scripts and styles. On the client it's
    // undefined here; the router reads it back from HeadContent's `<meta property="csp-nonce">`.
    // The context isn't typed through Register: server.ts is the Worker's main module, and typing it
    // there makes the router's own type circular.
    ssr: { nonce: (getGlobalStartContext() as { nonce?: string } | undefined)?.nonce },
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
