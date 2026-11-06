# ADR-0045: Security headers and a nonce-based Content Security Policy on the app

Status: Accepted (owner 2026-11-05: a short ADR under the freeze exception; HSTS one year without subdomains) · Date: 2026-11-05

Owner 2026-11-05: this is a new security ADR during the roadmap's freeze, accepted as an exception. The finding is proven and within M3's pre-pilot scope.

## Context

The app Worker sent no security headers (`curl -sIL` on `app.aaronlabr.dev`, 2026-11-05; runbook "Before admitting pilot users"). Without `frame-ancestors`, any site could frame the sign-in page. The docs and marketing sites already set theirs in `_headers` ([ADR-0028](0028-public-docs-site.md), [ADR-0033](0033-marketing-site-and-app-naming.md)). The app can't do the same, because its HTML comes from the Worker, not from static assets.

TanStack Start renders inline hydration scripts. A CSP that allows them without `unsafe-inline` needs a hash or a nonce. Start supports a nonce: `ssr.nonce` on the router puts it on every tag `HeadContent`, `Scripts` and `ScriptOnce` render. The only third-party origin is Turnstile ([ADR-0025](0025-turnstile-bot-protection-on-auth.md)): a script and an iframe from `https://challenges.cloudflare.com`.

## Decision

1. **A global request middleware sets the headers** (`src/start.ts`, outermost, so the CSRF 403 and the unknown-server-function 404 get them too). It's free of database work, like the rest of that chain ([ADR-0031](0031-production-alerting-issues-to-slack.md) note on `/api/ping`). The headers are built in `src/server/security-headers.ts`:
   - `Content-Security-Policy`: `default-src 'self'; script-src 'self' 'nonce-<n>' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. The dev server's policy adds `ws: wss:` to `connect-src` for Vite's client, and nothing else.
   - `Strict-Transport-Security: max-age=31536000`, without `includeSubDomains` or `preload` (owner 2026-11-05: the header covers the app host only, and nothing changes for the apex or other subdomains).
   - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` (for browsers without `frame-ancestors`).
2. **A new nonce per request**, 128 random bits, passed to the router through the middleware's context (`getGlobalStartContext()` in `src/router.tsx`).
3. **Static assets get their headers from `apps/app/public/_headers`** (HSTS, nosniff, Referrer-Policy). Workers Static Assets serves them without the Worker. A CSP does nothing on JS and CSS files, so they get none, and `wrangler.jsonc` doesn't change (no `run_worker_first`).
4. **Convention:** a new third-party script, frame or connection origin is added to this policy in the same PR that needs it. Allowing `unsafe-inline` or `unsafe-eval` for scripts, or relaxing `frame-ancestors`, needs a new ADR.

## Alternatives

- **Hashes instead of a nonce:** Start's inline scripts carry per-request data (the dehydrated router state), so their hashes change on every response. A nonce is what Start supports.
- **`_headers` for the app's HTML:** Workers Static Assets applies it only to responses it serves, and the app's HTML comes from the Worker.
- **`unsafe-inline` for scripts:** it would allow any injected inline script, which is the main thing a CSP is for.
- **`'strict-dynamic'`:** not needed. The Turnstile loader is created by the app's own script and is allowed by origin. It would also make browsers ignore the origin list, a change in the policy's meaning with no benefit today.

## Consequences

- An uncaught error that escapes the Worker is answered by the runtime without these headers. It carries no app HTML.
- CSP violations aren't reported anywhere. A `report-to` endpoint waits for an error tracker (ADR-0015).
- `e2e/security-headers.spec.ts` checks the headers on real responses and that the sign-in page with Turnstile loads without a violation. The full e2e suite proves hydration still works: forms stay disabled until it does.
- Raising HSTS to `includeSubDomains` or `preload` affects other hosts on `aaronlabr.dev` and needs the owner.
