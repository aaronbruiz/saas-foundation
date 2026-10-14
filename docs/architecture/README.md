# Architecture

```
browser ──HTTPS──▶ Cloudflare edge
                    ├─ static assets (served at the edge)
                    └─ Worker `saas-foundation` (TanStack Start SSR + server functions, placed in aws:us-east-1)
                          ├─ Better Auth (in-process)          → packages/auth
                          ├─ getTenantContext (/t/<slug>)      → apps/app/src/server
                          ├─ domain modules                    → apps/app/src/modules
                          └─ tenant-scoped repositories        → packages/db
                                   │ pg client per request
                                   ▼
                          Hyperdrive `DB` (caching disabled) ──▶ Neon Postgres (aws-us-east-1)

browser ──HTTPS──▶ docs.<zone> ──▶ Worker `saas-foundation-docs` (static assets only: Starlight
                                   site, Pagefind index, llms.txt, .md twins; no bindings, ADR-0028)
browser ──HTTPS──▶ <zone> (apex) ──▶ Worker `saas-foundation-site` (static assets only: landing,
                                   pricing from billing/policy.ts; links to app.<zone>; ADR-0033)
PR previews: Worker `saas-foundation-preview` (app, own Neon branch + Hyperdrive config, ADR-0021),
             `saas-foundation-docs-preview` and `saas-foundation-site-preview` (no bindings), on
             workers.dev
```

Rules: [`AGENTS.md`](../../AGENTS.md). Decisions: [`docs/adr/`](../adr/README.md).
