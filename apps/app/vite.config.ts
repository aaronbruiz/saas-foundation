import { globSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { readBuildInfo } from './build-info.ts'

// Base UI is imported by subpath (AGENTS.md module map), and Vite's dev server discovers each one
// only when a page first loads it: it then re-optimizes and reloads the page, which aborts any
// request in flight (a cold cache's first e2e or visual run fails that way). Every subpath the
// source imports is pre-bundled at startup instead, read from the source so the list can't drift.
const baseUi = [
  ...new Set(
    globSync('src/**/*.{ts,tsx}', { cwd: import.meta.dirname }).flatMap(
      (f) =>
        readFileSync(`${import.meta.dirname}/${f}`, 'utf8').match(/@base-ui\/react\/[a-z-]+/g) ??
        [],
    ),
  ),
].sort()

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  optimizeDeps: { include: baseUi },
  define: { __BUILD_INFO__: JSON.stringify(readBuildInfo()) },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
