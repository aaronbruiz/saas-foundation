// Runs in Node (not workerd) before the test suite: migrate the test database with the same
// drizzle-kit pipeline used everywhere else.
import { execSync } from 'node:child_process'

export default function setup() {
  execSync('pnpm --filter @saas-foundation/db db:migrate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'postgres://app:app@localhost:5432/app_test' },
  })
}
