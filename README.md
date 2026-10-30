# saas-foundation

Multi-tenant SaaS foundation on Cloudflare Workers: TanStack Start, Neon Postgres via Hyperdrive, Better Auth, Drizzle.

- Agent and contributor rules: [`AGENTS.md`](AGENTS.md)
- Architecture decisions: [`docs/adr/`](docs/adr/)
- Testing and troubleshooting: [`docs/testing.md`](docs/testing.md)

## Getting started

Requires Node 24 and pnpm (version pinned in `package.json`; `corepack enable` picks it up).

Also needs Docker (local Postgres 17).

```sh
pnpm install
cp apps/app/.dev.vars.example apps/app/.dev.vars   # then set BETTER_AUTH_SECRET
pnpm db:up    # local Postgres: dev DB `app`, test DB `app_test`
pnpm db:migrate
pnpm dev      # http://localhost:3000 (health: /api/health)
pnpm check    # lint + format check + typecheck
pnpm test     # Vitest inside workerd
```
