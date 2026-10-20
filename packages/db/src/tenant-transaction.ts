import { rawDb, type Db, type RawDb } from './client.ts'
import { GuardedClient, TenantTransactionError } from './connection.ts'
import type { TenantScope } from './tenancy.ts'

export { TenantTransactionError }

/** What a tenant transaction's body queries through: the request's client, owned by it meanwhile. */
export type Tx = RawDb

function guarded(db: Db | RawDb): { raw: RawDb; client: GuardedClient } {
  const raw = 'select' in db ? db : rawDb(db)
  const { $client } = raw as unknown as { $client: unknown }
  if (!($client instanceof GuardedClient)) {
    throw new TenantTransactionError('not a guarded connection (use createDb)')
  }
  return { raw, client: $client }
}

/**
 * Runs `fn` in a transaction that owns the request's connection until it ends (ADR-0040). Refused
 * when the connection is busy or in another transaction; while it runs, anything outside it on the
 * same connection is refused, and inside it nothing may end, nest or reconfigure it.
 */
export async function ownTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { raw, client } = guarded(db)
  return client.runOwned(() => fn(raw))
}

/** Sets the running tenant transaction's tenant, once (the webhook, after its organization lock). */
export async function enterTenant(tx: Tx, orgId: string): Promise<void> {
  if (!orgId) throw new TenantTransactionError('no tenant')
  await guarded(tx).client.setTenant(orgId)
}

/** Runs `fn` in its own tenant transaction with `scope`'s tenant set. Every tenant-table statement goes here. */
export function inTenant<T>(db: Db, scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!scope.orgId) return Promise.reject(new TenantTransactionError('no tenant'))
  return ownTransaction(db, async (tx) => {
    await enterTenant(tx, scope.orgId)
    return fn(tx)
  })
}
