// ESLint flat config (ADR-0006). Style is Prettier's job; this file holds
// correctness rules and the architecture boundaries from AGENTS.md.
import { readdirSync } from 'node:fs'
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const providerSdksOnlyInProviders = {
  regex: '^@polar-sh/[^/]+(/.*)?$',
  message:
    'Only apps/app/src/modules/billing/providers/** may import a billing provider SDK (AGENTS.md invariant 6).',
}

const uiMustNotTouchDataOrAuth = {
  group: [
    '@saas-foundation/db',
    '@saas-foundation/db/*',
    '@saas-foundation/auth',
    '@saas-foundation/auth/*',
    'drizzle-orm',
    'drizzle-orm/*',
  ],
  message: 'Routes and components go through modules/ or server/ (AGENTS.md invariants 1-2).',
}

// Raw database access (the Drizzle client, the schema, query builders) stays behind
// packages/db repositories (AGENTS.md invariant 2). A `Db` is an opaque handle; the
// client behind it comes only from @saas-foundation/db/internal. Routes and components
// go through modules/, so they don't import `server/db` either.
const noDrizzleOrm = {
  group: ['drizzle-orm', 'drizzle-orm/*'],
  message: 'Query tables through packages/db repository functions (AGENTS.md invariant 2).',
}

const noDbClient = {
  group: ['@saas-foundation/db'],
  importNames: ['createDb'],
  message:
    'Only server/db.ts and server/health.ts create a database client; use withDb (AGENTS.md invariant 2).',
}

const noRawDb = {
  group: ['@saas-foundation/db/internal'],
  message:
    'The raw client and schema are for packages/auth and tests; use repository functions (AGENTS.md invariant 2).',
}

const noServerDbInUi = {
  // Patterns match the import string, so this covers relative and aliased spellings.
  regex: '(^|/)server/db(\\.[cm]?[jt]sx?)?$',
  message: 'Routes and components reach data through modules/, not withDb (AGENTS.md invariant 2).',
}

// Path rules match the import string, so it must be normalized: no `//`, no `.`
// segment after the start, no `..` after a named segment (`a/../b`).
const unnormalized = '//|/\\.(/|$)|(^|/)(?!\\.\\.?/)[^/]+/\\.\\.(/|$)'
const unnormalizedPaths = {
  regex: unnormalized,
  message:
    'Write the import path normalized (no //, inner ./ or a/../), so lint can check it (AGENTS.md invariants 2-3).',
}

// A workspace package's files imported by path (`../` or absolute, through a `packages/` or
// `node_modules/` directory) skip its `exports` and every rule above: `packages/db/src/client.ts`
// hands out the raw client. Package names (`@scope/packages/x`) and `./` paths stay allowed.
const filePath = '^(/|(\\.\\./)+)(.*/)?(packages|node_modules)/'
const noFilePathImports = {
  regex: filePath,
  message: 'Import workspace packages by name, never by file path (AGENTS.md invariants 2-3).',
}

// no-restricted-imports doesn't see import(), so the same limits for dynamic
// imports, which must take a string literal for lint to check them. Selector regexes
// can't contain '/', hence \x2F.
const noDynamicRawDb = [
  {
    selector: `:matches(ImportExpression, TSImportType)[source.value=/${filePath.replaceAll('/', '\\x2F')}/]`,
    message: noFilePathImports.message,
  },
  {
    // Vite's glob imports take patterns lint can't check.
    selector: "CallExpression[callee.object.type='MetaProperty'][callee.property.name=/^glob/]",
    message: 'Import modules explicitly, not with import.meta.glob (AGENTS.md invariants 2-3).',
  },
  {
    selector: "ImportExpression[source.type!='Literal']",
    message:
      'import() takes a plain string literal, so lint can check it (AGENTS.md invariants 2-3).',
  },
  {
    selector: `:matches(ImportExpression, TSImportType)[source.value=/${unnormalized.replaceAll('/', '\\x2F')}/]`,
    message: unnormalizedPaths.message,
  },
  {
    selector: 'ImportExpression[source.value=/^drizzle-orm($|\\x2F)/]',
    message: noDrizzleOrm.message,
  },
  {
    selector: 'ImportExpression[source.value=/^@saas-foundation\\x2Fdb($|\\x2F)/]',
    message:
      'Import @saas-foundation/db statically; import() bypasses the createDb and internal limits (AGENTS.md invariant 2).',
  },
]

// ADR-0040: SQL that could set the tenant context or end a tenant transaction stays checkable.
// Only packages/db/src/connection.ts sets the context, always transaction-locally; its runtime
// guard refuses the same statements, so these rules are the first line, not the only one.
const tenantConnection = 'packages/db/src/connection.ts'
const setsContext = String.raw`set_config|\b(set|reset)\b[\s\S]*\bapp\b["\s]*\.`
const noSetConfig = {
  selector: `:matches(Literal[value=/${setsContext}/i], TemplateElement[value.raw=/${setsContext}/i], TemplateElement[value.cooked=/${setsContext}/i])`,
  message: `Only ${tenantConnection} sets the tenant context (set_config, SET/RESET app.*), always transaction-locally (ADR-0040).`,
}
const noSplitLiterals = {
  // A string split into literals ('set_' + 'config', `${'set_'}config`) hides it from every rule.
  selector:
    "BinaryExpression[operator='+'][left.type='Literal'][right.type='Literal'], TemplateLiteral > Literal",
  message: 'Write string literals whole; split literals hide SQL from lint (ADR-0040).',
}
const noRawSql = {
  // Also through an alias: `sql` is only ever imported and used under its own name.
  selector: [
    "MemberExpression:matches([property.name='raw'], [property.value='raw']):matches([object.name='sql'], [object.property.name='sql'])",
    "ImportSpecifier[imported.name='sql'][local.name!='sql']",
    'ImportDeclaration[source.value=/^drizzle-orm/] > ImportNamespaceSpecifier',
    "VariableDeclarator[init.name='sql']",
  ].join(', '),
  message:
    'No sql.raw and no alias of sql: SQL built at runtime cannot be checked (ADR-0040). Use the sql tag; values become parameters.',
}
const noDynamicQueryText = {
  selector:
    "CallExpression[callee.property.name=/^(execute|query)$/]:not([arguments.0.type='Literal']):not([arguments.0.tag.name='sql'])",
  message:
    'Pass SQL as the sql tag or a string literal, never as a value built at runtime (ADR-0040).',
}
const noClientAccess = {
  selector: ":matches(Identifier[name='$client'], Literal[value='$client'])",
  message: `The pg client stays inside packages/db: every statement goes through ${tenantConnection}'s guard (ADR-0040).`,
}
const noPgImport = {
  selector:
    'ImportDeclaration[source.value=/^pg($|\\x2F)/], ImportExpression[source.value=/^pg($|\\x2F)/]',
  message: 'Only packages/db talks to pg directly; use createDb (ADR-0040).',
}
// Everywhere unless a block below narrows it.
const sqlGuards = [noSetConfig, noSplitLiterals, noRawSql, noClientAccess, noPgImport]
// Application and package source (not tests or owner scripts).
const sourceSqlGuards = [...sqlGuards, noDynamicQueryText]

const noDynamicServerDbInUi = {
  selector: 'ImportExpression[source.value=/(^|\\x2F)server\\x2Fdb(\\.[cm]?[jt]sx?)?$/]',
  message: noServerDbInUi.message,
}

// AGENTS.md invariant 3: a module uses another module only through its public entry
// points. Every directory under modules/ is a module; one not listed here has none.
const publicEntryPoints = { billing: ['entitlements', 'policy'] }
const moduleNames = readdirSync(new URL('./apps/app/src/modules', import.meta.url), {
  withFileTypes: true,
})
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

function moduleBoundary(self) {
  const others = moduleNames
    .filter((m) => m !== self)
    .map((m) => {
      const open = publicEntryPoints[m] ?? []
      return open.length ? `${m}/(?!(${open.join('|')})(\\.[cm]?[jt]sx?)?$)` : `${m}/`
    })
  // `../<module>/` (relative) or `modules/<module>/` (aliased or from deeper files).
  // Paths are normalized (`unnormalizedPaths`), so no `./`, `//` or inner `..` here.
  const regex = `(^|/)(modules|\\.\\.)/(${others.join('|')})`
  const message =
    'Use another module only through its public entry points: modules/billing/{entitlements,policy} (AGENTS.md invariant 3).'
  return {
    pattern: { regex, message },
    selector: {
      // Also type-level `import('…').T`.
      selector: `:matches(ImportExpression, TSImportType)[source.value=/${regex.replaceAll('/', '\\x2F')}/]`,
      message,
    },
  }
}

const noInternalPackages = {
  group: ['@saas-foundation/*'],
  message: 'This package must not import other workspace packages (AGENTS.md module map).',
}

const onlyDbPackage = {
  group: ['@saas-foundation/*', '!@saas-foundation/db'],
  message: 'packages/auth may import only @saas-foundation/db (AGENTS.md module map).',
}

export default defineConfig([
  globalIgnores([
    '**/node_modules',
    '**/dist',
    '**/.wrangler',
    '**/.tanstack',
    '**/.astro',
    '**/routeTree.gen.ts',
    '**/worker-configuration.d.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'no-restricted-imports': ['error', { patterns: [providerSdksOnlyInProviders] }],
      'no-restricted-syntax': ['error', ...sqlGuards],
    },
  },
  {
    files: ['apps/app/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            providerSdksOnlyInProviders,
            noDrizzleOrm,
            noDbClient,
            noRawDb,
            unnormalizedPaths,
            noFilePathImports,
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...sourceSqlGuards, ...noDynamicRawDb],
    },
  },
  ...moduleNames.map((name) => ({
    files: [`apps/app/src/modules/${name}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            providerSdksOnlyInProviders,
            noDrizzleOrm,
            noDbClient,
            noRawDb,
            unnormalizedPaths,
            noFilePathImports,
            moduleBoundary(name).pattern,
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...sourceSqlGuards,
        ...noDynamicRawDb,
        moduleBoundary(name).selector,
      ],
    },
  })),
  {
    files: ['apps/app/src/routes/**/*.{ts,tsx}', 'apps/app/src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            providerSdksOnlyInProviders,
            uiMustNotTouchDataOrAuth,
            noServerDbInUi,
            unnormalizedPaths,
            noFilePathImports,
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...sourceSqlGuards,
        ...noDynamicRawDb,
        noDynamicServerDbInUi,
      ],
    },
  },
  {
    // The Better Auth handler is the one route allowed to mount packages/auth.
    files: ['apps/app/src/routes/api/auth/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            providerSdksOnlyInProviders,
            unnormalizedPaths,
            noFilePathImports,
            {
              ...uiMustNotTouchDataOrAuth,
              group: uiMustNotTouchDataOrAuth.group.filter((g) => !g.includes('/auth')),
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...sourceSqlGuards, ...noDynamicRawDb],
    },
  },
  {
    // The only two places that create a database client.
    files: ['apps/app/src/server/db.ts', 'apps/app/src/server/health.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            providerSdksOnlyInProviders,
            noDrizzleOrm,
            noRawDb,
            unnormalizedPaths,
            noFilePathImports,
          ],
        },
      ],
    },
  },
  {
    files: ['packages/db/**/*.ts', 'packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [providerSdksOnlyInProviders, noInternalPackages] },
      ],
    },
  },
  {
    files: ['packages/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...sourceSqlGuards] },
  },
  {
    // The database package owns the pg client.
    files: ['packages/db/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', noSetConfig, noSplitLiterals, noRawSql, noDynamicQueryText],
    },
  },
  {
    // The one place that sets the tenant context.
    files: [tenantConnection],
    rules: { 'no-restricted-syntax': ['error', noSplitLiterals, noRawSql, noDynamicQueryText] },
  },
  {
    // Owner-run migration scripts (not the app's connection).
    files: ['packages/db/scripts/**'],
    rules: { 'no-restricted-syntax': ['error', noSetConfig, noSplitLiterals, noRawSql] },
  },
  {
    // Tests reach the guarded client to prove its guard; they never set the context.
    files: ['apps/app/test/**', 'apps/app/e2e/**'],
    rules: {
      'no-restricted-syntax': ['error', noSetConfig, noSplitLiterals, noRawSql, noPgImport],
    },
  },
  {
    // The rules' own definitions and fixtures.
    files: ['eslint.config.js', 'scripts/lint-boundaries.test.mjs'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['packages/auth/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [providerSdksOnlyInProviders, onlyDbPackage] },
      ],
    },
  },
  {
    // Providers may import their SDK, but get no raw database access.
    files: ['apps/app/src/modules/billing/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            noDrizzleOrm,
            noDbClient,
            noRawDb,
            unnormalizedPaths,
            noFilePathImports,
            moduleBoundary('billing').pattern,
          ],
        },
      ],
    },
  },
  prettier,
])
