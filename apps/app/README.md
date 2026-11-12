# app

The single deployable Worker: TanStack Start (SSR, server functions, server routes) and Workers Static Assets. See the root [`AGENTS.md`](../../AGENTS.md) and [ADR-0002](../../docs/adr/0002-single-tanstack-start-worker.md).

Run everything from the repo root (`pnpm dev`, `pnpm check`, `pnpm build`). App-local scripts: `pnpm --filter app cf-typegen` generates `worker-configuration.d.ts` (git-ignored) from `wrangler.jsonc` and `.dev.vars.example`; `pnpm install` generates it (`postinstall`) and the app's `typecheck` regenerates it first, so `pnpm check` is always current. After a binding change or a new name in `.dev.vars.example`, run it (or `pnpm check`) for editor types; never edit the file by hand.
