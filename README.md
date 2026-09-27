# saas-foundation

Multi-tenant SaaS foundation on Cloudflare Workers: TanStack Start, Neon Postgres via Hyperdrive, Better Auth, Drizzle.

- Agent and contributor rules: [`AGENTS.md`](AGENTS.md)
- Architecture decisions: [`docs/adr/`](docs/adr/)

## Getting started

Requires Node 24 and pnpm (version pinned in `package.json`; `corepack enable` picks it up).

```sh
pnpm install
pnpm dev      # http://localhost:3000
pnpm check    # lint + format check + typecheck
```

Local Postgres, Hyperdrive and tests are added in Phase 0 step 2.
