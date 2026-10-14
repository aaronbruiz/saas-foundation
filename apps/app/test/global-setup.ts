// Runs in Node (not workerd) before the test suite: migrate the test database with the same
// drizzle-kit pipeline used everywhere else.
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    // What `/api/health` must report for this checkout (ADR-0029), derived here independently of
    // build-info.ts; workerd tests can't read files, run git or see the CI environment.
    expectedBuild: { version: string; commit: string; build: string }
  }
}

export default function setup(project: TestProject) {
  execSync('pnpm --filter @saas-foundation/db db:migrate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'postgres://app:app@localhost:5432/app_test' },
  })
  const { version } = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  const commit = execFileSync('git', ['log', '-1', '--format=%H'], { encoding: 'utf8' }).slice(0, 7)
  const { CI, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env
  const build = CI ? `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` : 'local'
  project.provide('expectedBuild', { version, commit, build })
}
