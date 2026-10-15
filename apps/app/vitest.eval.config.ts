// Polar sandbox evaluation only (eval/**, not part of `pnpm test`). Runs inside workerd like the app.
// Sandbox values come from the git-ignored apps/app/.dev.vars (POLAR_* keys only); nothing is logged.
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

const file = new URL('./.dev.vars', import.meta.url)
const polarVars: Record<string, string> = {}
if (existsSync(file))
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(POLAR_[A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m) polarVars[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ...polarVars,
          POLAR_EVAL_PHASE: process.env.POLAR_EVAL_PHASE ?? 'offline',
          POLAR_EVAL_RUN: process.env.POLAR_EVAL_RUN ?? '',
          POLAR_EVAL_PAID: process.env.POLAR_EVAL_PAID ?? '',
          POLAR_EVAL_CUSTOMER_IP: process.env.POLAR_EVAL_CUSTOMER_IP ?? '',
        },
      },
    }),
  ],
  test: { include: ['eval/**/*.test.ts'], testTimeout: 120_000 },
})
