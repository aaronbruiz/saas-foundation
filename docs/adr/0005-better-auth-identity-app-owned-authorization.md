# ADR-0005: Better Auth for identity; authorization is application code

Status: Accepted · Date: 2026-09-27

## Context

Authentication and authorization/tenancy are separate problems. Candidates were Better Auth, Auth.js, Clerk, WorkOS and custom auth.

## Decision

- Better Auth `^1.7` runs in-process, with the organization plugin and the Drizzle adapter. Sessions are stored in Postgres; no KV `secondaryStorage` (with it, sessions leave the DB unless `storeSessionInDatabase` is set).
- The schema is generated with `npx auth@latest generate` into `packages/db`; migrations go only through drizzle-kit.
- Default roles: `owner`, `admin`, `member`. Members can't invite; only the owner can delete the org.
- **Authorization is ours:** every tenant request resolves `{userId, orgId, role}` server-side by verifying membership (see ADR-0010).
- Login rate limiting (Phase 2): Better Auth `rateLimit.storage: "database"` plus a WAF rule. The in-memory limiter doesn't work across Worker isolates, and the Workers Rate Limiting binding is per location and approximate.

## Consequences

- One database for identity and domain data, with FKs to `organization.id`.
- We own the security configuration (trusted origins, cookies, rate limits).
- SSO/SCIM (Better Auth SSO or WorkOS) waits for an enterprise requirement.
