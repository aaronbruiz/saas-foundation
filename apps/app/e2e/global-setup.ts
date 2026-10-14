// Local runs only (no BASE_URL): every browser request reaches the dev server from 127.0.0.1
// (Miniflare sets CF-Connecting-IP from the socket), and one run spends the whole sign-in budget
// (5 a minute, ADR-0005), which Better Auth keeps in the database. Without this, a second run
// within a minute failed with 429s. Previews get a fresh database on every deploy.
import { createDb } from '@saas-foundation/db'
import { rawDb, schema } from '@saas-foundation/db/internal'

export default async function setup() {
  if (process.env.BASE_URL) return
  // The local dev database (wrangler.jsonc `localConnectionString`); known local credentials.
  const { db, close } = await createDb('postgres://app:app@localhost:5432/app')
  try {
    await rawDb(db).delete(schema.rateLimit)
  } finally {
    await close()
  }
}
