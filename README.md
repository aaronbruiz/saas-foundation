# saas-foundation

Multi-tenant SaaS foundation on Cloudflare Workers: TanStack Start, Neon Postgres via Hyperdrive, Better Auth, Drizzle.

- Agent and contributor rules: [`AGENTS.md`](AGENTS.md)
- Architecture decisions: [`docs/adr/`](docs/adr/)

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

## Troubleshooting

- **`pnpm test` hits "Test timed out in 5000ms"** on a loaded or small machine (seen on 8 CPUs, 8 GB, WSL2), in different tests each run: run with fewer workers and a longer timeout, `pnpm --filter app test --maxWorkers=1 --testTimeout=30000`. The defaults stay as they are for CI.
- **`pnpm test:e2e` fails with "Too many requests"**: the run used up the login rate limit (ADR-0005). See `docs/runbooks/start-new-product.md` step 6, "E2E".
