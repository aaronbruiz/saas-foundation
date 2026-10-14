// Raw database access: the Drizzle client behind a `Db`, and the schema. For packages/auth (Better
// Auth's adapter) and tests only; eslint.config.js keeps it out of apps/app/src.
export { asDb, rawDb, type RawDb } from './client.ts'
export * as schema from './schema/index.ts'
