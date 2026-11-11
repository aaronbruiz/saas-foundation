// packages/contracts sets zod's `jitless` before it builds any schema, so zod never probes
// `new Function` (ADR-0045: the app's CSP refuses eval, and browsers report the probe). Runs in
// Node, outside workerd, where zod would otherwise probe (it skips only under a Cloudflare user
// agent). Run by `pnpm lint`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('importing contracts never calls Function, and leaves jitless set', async () => {
  const calls = []
  const RealFunction = globalThis.Function
  globalThis.Function = new Proxy(RealFunction, {
    construct(target, args) {
      calls.push(args)
      return Reflect.construct(target, args)
    },
    apply(target, self, args) {
      calls.push(args)
      return Reflect.apply(target, self, args)
    },
  })
  try {
    const contracts = await import('../packages/contracts/src/index.ts')
    // Parse once too: a lazily built schema would probe on first use.
    contracts.ProjectFields.safeParse({ name: 'x' })
  } finally {
    globalThis.Function = RealFunction
  }
  assert.deepEqual(calls, [], 'zod called Function: z.config({ jitless: true }) must run first')
  assert.equal(globalThis.__zod_globalConfig?.jitless, true)
})
