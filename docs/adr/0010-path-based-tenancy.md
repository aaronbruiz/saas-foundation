# ADR-0010: Address tenants by URL path (`/t/<slug>`), not subdomain

Status: Accepted · Date: 2026-09-27

## Context

Previews already use the hostname (`pr-143.preview.example.com`). Subdomain tenancy would need wildcard DNS/TLS, cookie scoping and per-host auth callbacks.

## Decision

- Tenants live at `app.example.com/t/<slug>/…`. The slug is a **selector only**.
- `getTenantContext(request, env, slug)` resolves slug → org → membership through the uncached `DB`. Unknown slug or non-member → **404**.
- TanStack server functions aren't served under `/t/…`, so every tenant-scoped server function takes `tenant` as a Zod-validated input and calls `getTenantContext` itself.
- Better Auth's `activeOrganizationId` only chooses the landing tenant after login.

## Consequences

- One host, cookie domain, certificate and callback URL; previews need no tenant DNS.
- Per-tenant custom domains would need rework (trigger: an enterprise or white-label requirement).

## Notes (2026-10-15)

**Signature.** `getTenantContext` now takes `(db, headers, slug)`: the caller opens the database handle (`withDb`) and passes the request headers. It still resolves slug → org → membership through the uncached `DB` on every call; the decision is unchanged.
