# ADR-0005: Better Auth for identity; authorization is application code

Status: Accepted · Date: 2026-09-27

## Context

Authentication and authorization/tenancy are separate problems. Candidates were Better Auth, Auth.js, Clerk, WorkOS and custom auth.

## Decision

- Better Auth `^1.7` runs in-process, with the organization plugin and the Drizzle adapter. Sessions are stored in Postgres; no KV `secondaryStorage` (with it, sessions leave the DB unless `storeSessionInDatabase` is set).
- The schema is generated with `npx auth@latest generate` into `packages/db`; migrations go only through drizzle-kit.
- Default roles: `owner`, `admin`, `member`. Members can't invite; only the owner can delete the org.
- **Authorization is ours:** every tenant request resolves `{userId, orgId, role}` server-side by verifying membership (see ADR-0010).
- **Capability matrix** (`apps/web/src/server/permissions.ts`): server functions call `authorize(ctx, capability)` right after `getTenantContext`, so outsiders get 404 before any role check and members with an insufficient role get 403. Unknown roles grant nothing; comma-separated Better Auth multi-roles get the union.

  | Capability                                              | owner | admin | member |
  | ------------------------------------------------------- | :---: | :---: | :----: |
  | `project:read` / `create` / `update`                    |  yes  |  yes  |  yes   |
  | `project:delete` (hard delete, no audit trail yet)      |  yes  |  yes  |   no   |
  | `member:invite` (as `member` or `admin`)                |  yes  |  yes  |   no   |
  | _Better Auth HTTP endpoints (its default roles):_       |       |       |        |
  | organization update (name, slug)                        |  yes  |  yes  |   no   |
  | invite, change role, remove: non-owner members          |  yes  |  yes  |   no   |
  | invite as owner, grant owner, change or remove an owner |  yes  |  no   |   no   |
  | organization delete                                     |  yes  |  no   |   no   |

  Better Auth's `/api/auth/organization/*` endpoints are reachable over HTTP and enforce its default roles on their own (1.7.6: non-owners can't invite or grant `owner` or touch an owner). The rows above are those defaults, accepted as ours; `test/roles.test.ts` checks them over HTTP. Changing them means Better Auth `ac`/`roles` config, this table and the tests together. `getTenant` needs membership only (it returns what every member may see). The UI gets the capabilities from `getTenant` to hide actions; it never decides.

- Login rate limiting: Better Auth `rateLimit.storage: "database"` plus a WAF rule. The in-memory limiter doesn't work across Worker isolates, and the Workers Rate Limiting binding is per location and approximate. Details below.

## Login rate limiting (Phase 2)

**App layer (in code, `packages/auth/src/auth.ts`):**

- `rateLimit: { enabled: true, storage: "database" }`. Counters live in the Better Auth `rate_limit` table (generated schema). Better Auth's check-and-increment is a conditional update, so concurrent requests can't all pass. `enabled: true` is explicit: Better Auth's default is production only, and we want dev, tests and previews to behave like prod.
- Limits, per client IP and path: `POST /api/auth/sign-in/email` and `/sign-up/email` allow **5 per 60 s**. Other methods on those paths aren't counted (they reach no handler). Other auth endpoints allow 100 per 60 s, except Better Auth's built-in stricter rules: other `/sign-in*`, `/sign-up*`, `/change-password*` and `/change-email*` paths 3 per 10 s; password reset and verification email 3 per 60 s. Over the limit: **429** with `X-Retry-After`.
- Client IP = `cf-connecting-ip` (`advanced.ipAddress.ipAddressHeaders`). Cloudflare's edge sets it and overwrites any value the client sends. Better Auth's default (`x-forwarded-for`) is absent on Workers. Without a trusted IP, Better Auth falls back to one shared bucket for all clients, which would let 5 bad logins lock everyone out.
- Only HTTP requests through `/api/auth/*` are limited. Direct `auth.api.*` server calls are not, so login and sign-up must stay on the HTTP client (`authClient`).
- Tests (`apps/web/test/rate-limit.test.ts`): sign-in and sign-up return 429 after 5 requests, a correct password is also refused while limited, other IPs are unaffected, and the counter row is in Postgres.

**Edge layer: WAF rate limiting rule (owner applies in the dashboard; not in code, no new binding).** Defense in depth: the app limiter above stays the primary, deterministic control.

**Blocked until the production custom domain (zone) exists:** WAF rules apply to requests on a zone, not to `*.workers.dev` or preview URLs.

Rule for the Free zone plan (owner decision 2026-09-28):

- Security → WAF → Rate limiting rules → Create rule, name `auth-login-burst`. Free allows one rate limiting rule.
- Expression (path only; Free rule expressions can't use other fields):
  `(http.request.uri.path in {"/api/auth/sign-in/email" "/api/auth/sign-up/email"})`
- Counting characteristic: IP. Counting period: **10 s**. Mitigation (block) period: **10 s**. Both are the only values Free offers.
- Requests per period: **10**. This is our choice, not a plan limit. It sits above what the app allows (5 per 60 s), so the edge rule only absorbs bursts before they reach the Worker and Postgres.
- Method: Free (and Pro) can't match `http.request.method`; that field needs **Business**. So any request to those paths counts. Accepted: the counter is per IP, so only the client's own traffic (or its NAT peers) can fill it, and the block lasts 10 s. On Business, add `and http.request.method eq "POST"`.
- After applying: smoke-test it on its own (runbook "First production deploy", step 10).
- Plan limits source: Cloudflare WAF docs, "Rate limiting rules: availability by plan" (checked 2026-09-28).

**No test exemption** (owner decision 2026-09-28): E2E runs against the real limit; any bypass would be code or config that could reach production. Each run makes 3 sign-ups, so leave about a minute between local runs.

**Accepted limits:** counting is per IP only, so distributed credential stuffing (many IPs) is not stopped by either layer; per-account lockout and bot protection (Turnstile) wait for a trigger (abuse observed or before public launch). Every `/api/auth/*` request costs one extra DB round-trip. Users behind one NAT share a bucket.

## Consequences

- One database for identity and domain data, with FKs to `organization.id`.
- We own the security configuration (trusted origins, cookies, rate limits).
- SSO/SCIM (Better Auth SSO or WorkOS) waits for an enterprise requirement.
