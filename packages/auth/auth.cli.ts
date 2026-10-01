// Entry point for the Better Auth CLI only (`pnpm auth:generate`): it reads the plugin schema
// definitions from this instance. The mock Drizzle client never connects to a database.
import { drizzle } from 'drizzle-orm/node-postgres'
import { schema } from '@saas-foundation/db'
import { createAuth } from './src/auth.ts'

export const auth = createAuth({
  db: drizzle.mock({ schema }),
  secret: 'cli-only-not-a-secret-0123456789',
  baseURL: 'http://localhost:3000',
  allowSignUp: () => true,
  requireEmailVerification: true,
  sendEmail: async () => {},
})
