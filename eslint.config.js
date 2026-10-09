// ESLint v9 flat config (ADR-0006). Style is Prettier's job; this file holds
// correctness rules and the architecture boundaries from AGENTS.md.
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

// Raw database access (a client, the schema, query builders) stays behind
// packages/db repositories (AGENTS.md invariant 2). A `Db` reaches `db.query.*`
// without any import, so routes and components can't import `server/db` either.
const noDrizzleOrm = {
  group: ['drizzle-orm', 'drizzle-orm/*'],
  message: 'Query tables through packages/db repository functions (AGENTS.md invariant 2).',
}

const noDbClientOrSchema = {
  group: ['@saas-foundation/db'],
  importNames: ['createDb', 'schema'],
  message:
    'Only server/db.ts and server/health.ts create a database client; use repository functions (AGENTS.md invariant 2).',
}

const noServerDbInUi = {
  // Patterns match the import string, so this covers relative and aliased spellings.
  regex: '(^|/)server/db$',
  message: 'Routes and components reach data through modules/, not withDb (AGENTS.md invariant 2).',
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
        { patterns: [providerSdksOnlyInProviders, noDrizzleOrm, noDbClientOrSchema] },
      ],
    },
  },
  {
    files: ['apps/web/src/routes/**/*.{ts,tsx}', 'apps/web/src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [providerSdksOnlyInProviders, uiMustNotTouchDataOrAuth, noServerDbInUi] },
      ],
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
            {
              ...uiMustNotTouchDataOrAuth,
              group: uiMustNotTouchDataOrAuth.group.filter((g) => !g.includes('/auth')),
            },
          ],
        },
      ],
    },
  },
  {
    // The only two places that create a database client.
    files: ['apps/web/src/server/db.ts', 'apps/web/src/server/health.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [providerSdksOnlyInProviders, noDrizzleOrm] }],
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
      'no-restricted-imports': ['error', { patterns: [noDrizzleOrm, noDbClientOrSchema] }],
    },
  },
  prettier,
])
