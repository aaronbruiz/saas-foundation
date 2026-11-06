import handler from '@tanstack/react-start/server-entry'
import { newNonce, withSecurityHeaders } from './server/security-headers'

// ADR-0045: the Worker's entry (`main` in wrangler.jsonc). It wraps Start's default entry, which keeps
// its own request scope, path validation and error handling, so the headers reach every response
// Start produces, including the 400 for a malformed path and its 500s. Not wrapped in
// `createServerEntry`: that validates the path before calling us. The nonce goes to the router
// through the request context (router.tsx).
export default {
  async fetch(request: Request, opts?: Parameters<typeof handler.fetch>[1]): Promise<Response> {
    const nonce = newNonce()
    const response = await handler.fetch(request, { ...opts, context: { ...opts?.context, nonce } })
    return withSecurityHeaders(response, nonce, import.meta.env.DEV)
  },
}
