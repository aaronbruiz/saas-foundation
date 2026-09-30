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

const noInternalPackages = {
  group: ['@saas-foundation/*'],
  message: 'This package must not import other workspace packages (AGENTS.md module map).',
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
    },
  },
  {
    files: ['apps/web/src/routes/**/*.{ts,tsx}', 'apps/web/src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [providerSdksOnlyInProviders, uiMustNotTouchDataOrAuth] },
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
    files: ['packages/db/**/*.ts', 'packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [providerSdksOnlyInProviders, noInternalPackages] },
      ],
    },
  },
  {
    files: ['apps/web/src/modules/billing/providers/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier,
])
