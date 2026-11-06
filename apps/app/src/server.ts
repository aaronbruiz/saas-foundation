import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { newNonce, withSecurityHeaders } from './server/security-headers'

// ADR-0045: the Worker's entry (`main` in wrangler.jsonc), wrapping Start's default one, so the
// headers reach every response Start produces, including its own 400s and 500s that never run
// request middleware. The nonce goes to the router through the request context (router.tsx).
export default createServerEntry({
  async fetch(request, opts) {
    const nonce = newNonce()
    const response = await handler.fetch(request, { ...opts, context: { ...opts?.context, nonce } })
    return withSecurityHeaders(response, nonce, import.meta.env.DEV)
  },
})
