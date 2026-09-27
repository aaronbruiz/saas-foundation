// drizzle-kit is the only migration pipeline (ADR-0003, ADR-0005).
// DATABASE_URL defaults to the local docker-compose database; CI and cloud steps set it explicitly.
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app',
  },
})
