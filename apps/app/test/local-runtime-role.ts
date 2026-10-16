// ADR-0038: migration 0005 creates `app_runtime` without a login; each environment gives it one
// separately (production: the runbook, never a committed password). For local and CI Postgres only
// (docker-compose's known credentials), this gives it the local password the DB binding uses. Roles
// are cluster-wide, so one call covers `app` and `app_test`. Run after migrating.
import { createDb } from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'

export async function enableLocalRuntimeLogin() {
  const { db, close } = await createDb('postgres://app:app@localhost:5432/app_test')
  try {
    await (
      rawDb(db) as unknown as { $client: { query: (q: string) => Promise<unknown> } }
    ).$client.query("ALTER ROLE app_runtime WITH LOGIN PASSWORD 'app_runtime'")
  } finally {
    await close()
  }
}
