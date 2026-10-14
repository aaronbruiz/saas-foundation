import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export type BuildInfo = { version: string; commit: string; build: string }

/**
 * ADR-0029 decision 4: what this build is, fixed at build time and injected with Vite `define`
 * (`__BUILD_INFO__`, read by `src/server/health.ts`). Runs in Node, at config load.
 */
export function readBuildInfo(): BuildInfo {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version?: string
  }
  if (!pkg.version) throw new Error('root package.json has no version (ADR-0029)')
  let commit = 'unknown'
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7)
  } catch {
    // Not a git checkout (e.g. a source tarball): the version and build id still identify it.
  }
  // CI: unique per upload, so the release smoke test can tell this build from the live one.
  const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt } = process.env
  const build = run && attempt ? `${run}-${attempt}` : 'local'
  return { version: pkg.version, commit, build }
}
