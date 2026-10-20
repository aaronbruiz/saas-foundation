// Proves the import boundaries in eslint.config.js (AGENTS.md invariants 2, 3, 6 and the module
// map) fire, each with its own message, against the real flat config. Files are virtual: lintText
// never reads them, but module blocks come from the directories under modules/, so fixtures use
// existing modules. Run by `pnpm lint`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ESLint } from 'eslint'

const root = new URL('..', import.meta.url).pathname
const eslint = new ESLint({ cwd: root })
const BOUNDARY_RULES = new Set([
  'no-restricted-imports',
  'no-restricted-syntax',
  '@typescript-eslint/no-require-imports',
])

const route = 'apps/app/src/routes/fixture.tsx'
const component = 'apps/app/src/components/fixture.tsx'
const projects = 'apps/app/src/modules/projects/fixture.ts'
const billing = 'apps/app/src/modules/billing/fixture.ts'
const provider = 'apps/app/src/modules/billing/providers/fixture.ts'
const server = 'apps/app/src/server/fixture.ts'
const lib = 'apps/app/src/lib/fixture.ts'

// Fragments of each restriction's message.
const SERVER_DB = 'not withDb'
const UI = 'Routes and components go through'
const DRIZZLE = 'Query tables through'
const CREATE_DB = 'create a database client'
const RAW_DB = 'raw client and schema'
const DYNAMIC_DB = 'Import @saas-foundation/db statically'
const LITERAL = 'plain string literal'
const NORMALIZED = 'normalized'
const FILE_PATH = 'never by file path'
const GLOB = 'import.meta.glob'
const MODULE = 'public entry points'
const PROVIDER = 'billing provider SDK'
const NO_PACKAGES = 'must not import other workspace packages'
const ONLY_DB = 'may import only @saas-foundation/db'
const REQUIRE = 'require()'
const SET_CONFIG = 'sets the tenant context'
const SPLIT = 'Write string literals whole'
const RAW_SQL = 'No sql.raw'
const QUERY_TEXT = 'Pass SQL as the sql tag'
const CLIENT = 'The pg client stays inside packages/db'
const PG = 'Only packages/db talks to pg'

/** [file, code, fragment of the expected message, or null when the import is allowed] */
const cases = [
  // Routes and components reach data through modules/, never server/db.
  [route, `import { withDb } from '../server/db'`, SERVER_DB],
  [route, `import type { withDb } from '../server/db'`, SERVER_DB],
  [route, `export { withDb } from '../server/db'`, SERVER_DB],
  [route, `export * from '../server/db'`, SERVER_DB],
  [route, `import { withDb } from '../server/db.ts'`, SERVER_DB],
  [route, `const f = () => import('../server/db')`, SERVER_DB],
  [component, `import { withDb } from '../server/db'`, SERVER_DB],
  [route, `import { projects } from '@saas-foundation/db'`, UI],
  [route, `import { eq } from 'drizzle-orm'`, UI],
  [route, `import { authFor } from '@saas-foundation/auth'`, UI],
  [route, `import { getTenantContext } from '../server/context'`, null],
  [
    'apps/app/src/routes/api/auth/fixture.ts',
    `import { authFor } from '@saas-foundation/auth'`,
    null,
  ],
  // SQL that could set the tenant context or end a tenant transaction stays checkable (ADR-0040).
  ['packages/db/src/connection.ts', "const q = `select set_config('app.org_id', $1, true)`", null],
  [
    'packages/db/src/tenant-transaction.ts',
    "const q = sql`select set_config('app.org_id', ${id}, true)`",
    SET_CONFIG,
  ],
  [
    'packages/db/src/tenancy.ts',
    "const q = sql`select set_config('app.org_id', ${id}, true)`",
    SET_CONFIG,
  ],
  [
    'packages/db/src/billing.ts',
    `const q = "SELECT SET_CONFIG('app.org_id', $1, false)"`,
    SET_CONFIG,
  ],
  [
    'packages/auth/src/fixture.ts',
    "const q = sql`select set_config('app.org_id', ${id}, true)`",
    SET_CONFIG,
  ],
  [server, "const q = sql`select set_config('app.org_id', ${id}, true)`", SET_CONFIG],
  [projects, `const q = 'select set_config($1, $2, false)'`, SET_CONFIG],
  [route, `const q = 'select set_config($1, $2, false)'`, SET_CONFIG],
  ['apps/app/test/fixture.test.ts', `const q = 'select set_config($1, $2, false)'`, SET_CONFIG],
  [server, "const q = sql`select set_\\u0063onfig('app.org_id', ${id}, false)`", SET_CONFIG],
  [server, `const q = 'select set_\\u0063onfig($1, $2, false)'`, SET_CONFIG],
  ['packages/db/src/tenancy.ts', `const q = "SET app.org_id = 'other'"`, SET_CONFIG],
  ['packages/db/src/tenancy.ts', 'const q = `set local "app".org_id to ${x}`', SET_CONFIG],
  ['packages/db/src/tenancy.ts', `const q = 'RESET app.org_id'`, SET_CONFIG],
  ['apps/app/test/fixture.test.ts', `const q = 'set session app.org_id = 1'`, SET_CONFIG],
  ['packages/db/src/tenancy.ts', `const q = "update project set name = 'x'"`, null],
  ['packages/db/src/tenancy.ts', `const q = 'select set_' + 'config($1, $2, false)'`, SPLIT],
  ['packages/db/src/tenancy.ts', "const q = `select ${'set_'}config($1, $2, false)`", SPLIT],
  ['apps/app/test/fixture.test.ts', `const q = 'set_' + 'config'`, SPLIT],
  ['packages/db/src/tenancy.ts', `const q = sql.raw(text)`, RAW_SQL],
  ['packages/db/src/tenancy.ts', "const q = sql.raw('select 1')", RAW_SQL],
  ['packages/db/src/tenancy.ts', `const q = sql['raw'](text)`, RAW_SQL],
  ['packages/db/src/tenancy.ts', `const r = sql.raw`, RAW_SQL],
  ['packages/db/src/tenancy.ts', `const { raw } = sql`, RAW_SQL],
  ['packages/db/src/tenancy.ts', `import { sql as s } from 'drizzle-orm'`, RAW_SQL],
  ['packages/db/src/tenancy.ts', `import * as d from 'drizzle-orm'`, RAW_SQL],
  ['packages/db/src/tenancy.ts', `const q = d.sql.raw(text)`, RAW_SQL],
  ['packages/db/src/tenancy.ts', `const s = sql`, RAW_SQL],
  ['packages/db/src/tenancy.ts', `import { sql } from 'drizzle-orm'`, null],
  ['packages/db/src/tenancy.ts', 'await client.query(String.raw`select ${text}`)', QUERY_TEXT],
  ['packages/db/src/tenancy.ts', 'await tx.execute(s`select ${x}`)', QUERY_TEXT],
  ['packages/db/src/tenancy.ts', `await tx.execute(text)`, QUERY_TEXT],
  ['packages/db/src/tenancy.ts', 'await tx.execute(`select ${x}`)', QUERY_TEXT],
  ['packages/db/src/tenancy.ts', `await client.query('select ' + x)`, QUERY_TEXT],
  ['packages/db/src/tenancy.ts', 'await tx.execute(sql`select ${x}`)', null],
  ['packages/db/src/tenancy.ts', `await client.query('select 1')`, null],
  ['packages/auth/src/fixture.ts', `const c = rawDb(db).$client`, CLIENT],
  ['packages/auth/src/fixture.ts', `const { $client } = rawDb(db)`, CLIENT],
  ['packages/auth/src/fixture.ts', `const c = rawDb(db)['$client']`, CLIENT],
  [server, `const c = x.$client`, CLIENT],
  ['packages/db/src/tenancy.ts', `const c = rawDb(db).$client`, null],
  ['apps/app/test/fixture.test.ts', `const c = rawDb(db).$client`, null],
  ['packages/auth/src/fixture.ts', `import { Client } from 'pg'`, PG],
  [server, `const pg = await import('pg')`, PG],
  ['apps/app/test/fixture.test.ts', `import pg from 'pg'`, PG],
  ['packages/db/src/connection.ts', `import { Client } from 'pg'`, null],
  // Raw database access stays in packages/db.
  [projects, `import { eq } from 'drizzle-orm/sql'`, DRIZZLE],
  [server, `import { eq } from 'drizzle-orm'`, DRIZZLE],
  [projects, `const f = () => import('drizzle-orm')`, DRIZZLE],
  [projects, `import { createDb } from '@saas-foundation/db'`, CREATE_DB],
  [projects, `import { createDb as c } from '@saas-foundation/db'`, CREATE_DB],
  [projects, `import * as db from '@saas-foundation/db'`, CREATE_DB],
  [projects, `export { createDb } from '@saas-foundation/db'`, CREATE_DB],
  [server, `import { createDb } from '@saas-foundation/db'`, CREATE_DB],
  [lib, `import { createDb } from '@saas-foundation/db'`, CREATE_DB],
  ['apps/app/src/server/db.ts', `import { createDb } from '@saas-foundation/db'`, null],
  [projects, `import { projects } from '@saas-foundation/db'`, null],
  [projects, `import { rawDb } from '@saas-foundation/db/internal'`, RAW_DB],
  [server, `import { rawDb } from '@saas-foundation/db/internal'`, RAW_DB],
  [provider, `import { rawDb } from '@saas-foundation/db/internal'`, RAW_DB],
  [projects, `const f = () => import('@saas-foundation/db')`, DYNAMIC_DB],
  // import() must be checkable.
  [route, 'const f = () => import(`../server/db`)', LITERAL],
  [route, `const p = '../server/db'; const f = () => import(p)`, LITERAL],
  [route, `const db = require('../server/db')`, REQUIRE],
  // Paths are normalized, and workspace packages are imported by name.
  [route, `import { withDb } from '../server/./db'`, NORMALIZED],
  [route, `import { withDb } from '../modules/../server/db'`, NORMALIZED],
  [projects, `import { x } from '../billing/entitlements/../service'`, NORMALIZED],
  [projects, `import { rawDb } from '../../../../../packages/db/src/client.ts'`, FILE_PATH],
  [projects, `import { rawDb } from '${root}packages/db/src/client.ts'`, FILE_PATH],
  [
    projects,
    `import { rawDb } from '../../../node_modules/@saas-foundation/db/src/client.ts'`,
    FILE_PATH,
  ],
  [projects, `export { rawDb } from '../../../../../packages/db/src/client.ts'`, FILE_PATH],
  [projects, `const f = () => import('../../../../../packages/db/src/client.ts')`, FILE_PATH],
  [projects, `type T = typeof import('../../../../../packages/db/src/client.ts')`, FILE_PATH],
  [route, `import { rawDb } from '../../../../packages/db/src/internal.ts'`, FILE_PATH],
  [server, `import { rawDb } from '../../../../packages/db/src/client.ts'`, FILE_PATH],
  [provider, `import { x } from '../../../../../../packages/db/src/client.ts'`, FILE_PATH],
  [projects, `const m = import.meta.glob('../../../../../packages/db/src/*.ts')`, GLOB],
  [route, `import css from '/src/styles.css?url'`, null],
  [projects, `import { x } from '@example/packages/util'`, null],
  [projects, `import { x } from './packages/local'`, null],
  // Modules use each other only through public entry points.
  [projects, `import { getBillingOverview } from '../billing/service'`, MODULE],
  [projects, `import type { BillingProvider } from '../billing/provider'`, MODULE],
  [projects, `import { x } from '../billing/providers/polar'`, MODULE],
  [projects, `import { x } from '../../modules/billing/webhook'`, MODULE],
  [projects, `import { x } from '../billing/entitlementsX'`, MODULE],
  [projects, `export * from '../billing/service'`, MODULE],
  [projects, `const f = () => import('../billing/service')`, MODULE],
  [projects, `type T = typeof import('../billing/service')`, MODULE],
  [projects, `import { x } from '../organizations/service'`, MODULE],
  [billing, `import { x } from '../projects/service'`, MODULE],
  [provider, `import { x } from '../../projects/service'`, MODULE],
  [projects, `import { entitlementsIn } from '../billing/entitlements'`, null],
  [projects, `import { PLANS } from '../billing/policy.ts'`, null],
  [billing, `import { x } from './service'`, null],
  // Only providers know the billing provider (invariant 6).
  [projects, `import { Polar } from '@polar-sh/sdk'`, PROVIDER],
  [provider, `import { Polar } from '@polar-sh/sdk'`, null],
  // Package imports follow the module map.
  ['packages/db/src/fixture.ts', `import { x } from '@saas-foundation/contracts'`, NO_PACKAGES],
  ['packages/contracts/src/fixture.ts', `import { x } from '@saas-foundation/db'`, NO_PACKAGES],
  ['packages/auth/src/fixture.ts', `import { x } from '@saas-foundation/contracts'`, ONLY_DB],
  ['packages/auth/src/fixture.ts', `import { rawDb } from '@saas-foundation/db/internal'`, null],
]

for (const [file, code, expected] of cases) {
  test(`${expected ? 'refuses' : 'allows'} ${code} in ${file}`, async () => {
    const [result] = await eslint.lintText(code, { filePath: file })
    const messages = result.messages
      .filter((m) => BOUNDARY_RULES.has(m.ruleId))
      .map((m) => m.message)
    if (expected === null) assert.deepEqual(messages, [])
    else
      assert.ok(
        messages.some((m) => m.includes(expected)),
        JSON.stringify(messages),
      )
  })
}
