// ESLint v9 flat config (ADR-0006). Style is Prettier's job; this file holds
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
    'Only apps/web/src/modules/billing/providers/** may import a billing provider SDK (AGENTS.md invariant 6).',
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

// no-restricted-imports doesn't see import(), so the same limits for dynamic
// imports, which must take a string literal for lint to check them. Selector regexes
// can't contain '/', hence \x2F.
const noDynamicRawDb = [
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

const noDynamicServerDbInUi = {
  selector: 'ImportExpression[source.value=/(^|\\x2F)server\\x2Fdb(\\.[cm]?[jt]sx?)?$/]',
  message: noServerDbInUi.message,
}

// AGENTS.md invariant 3: a module uses another module only through its public entry
// points. Every directory under modules/ is a module; one not listed here has none.
const publicEntryPoints = { billing: ['entitlements', 'policy'] }
const moduleNames = readdirSync(new URL('./apps/web/src/modules', import.meta.url), {
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
    '**/routeTree.gen.ts',
    '**/worker-configuration.d.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'no-restricted-imports': ['error', { patterns: [providerSdksOnlyInProviders] }],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
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
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...noDynamicRawDb],
    },
  },
  ...moduleNames.map((name) => ({
    files: [`apps/web/src/modules/${name}/**/*.{ts,tsx}`],
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
            moduleBoundary(name).pattern,
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...noDynamicRawDb, moduleBoundary(name).selector],
    },
  })),
  {
    files: ['apps/web/src/routes/**/*.{ts,tsx}', 'apps/web/src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            providerSdksOnlyInProviders,
            uiMustNotTouchDataOrAuth,
            noServerDbInUi,
            unnormalizedPaths,
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...noDynamicRawDb, noDynamicServerDbInUi],
    },
  },
  {
    // The Better Auth handler is the one route allowed to mount packages/auth.
    files: ['apps/web/src/routes/api/auth/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            providerSdksOnlyInProviders,
            unnormalizedPaths,
            {
              ...uiMustNotTouchDataOrAuth,
              group: uiMustNotTouchDataOrAuth.group.filter((g) => !g.includes('/auth')),
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...noDynamicRawDb],
    },
  },
  {
    // The only two places that create a database client.
    files: ['apps/web/src/server/db.ts', 'apps/web/src/server/health.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [providerSdksOnlyInProviders, noDrizzleOrm, noRawDb, unnormalizedPaths] },
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
    files: ['apps/web/src/modules/billing/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            noDrizzleOrm,
            noDbClient,
            noRawDb,
            unnormalizedPaths,
            moduleBoundary('billing').pattern,
          ],
        },
      ],
    },
  },
  prettier,
])
