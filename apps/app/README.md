# app

The single deployable Worker: TanStack Start (SSR, server functions, server routes) and Workers Static Assets. See the root [`AGENTS.md`](../../AGENTS.md) and [ADR-0002](../../docs/adr/0002-single-tanstack-start-worker.md).

Run everything from the repo root (`pnpm dev`, `pnpm check`, `pnpm build`). App-local scripts: `pnpm --filter app cf-typegen` regenerates `worker-configuration.d.ts` after binding changes, a new name in `.dev.vars.example` or a Wrangler/workerd bump; `pnpm check` fails until you do (`types:check`, `wrangler types --check`). That check compares the generation inputs recorded in the file header, not its body: never edit the file by hand.
