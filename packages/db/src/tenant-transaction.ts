import { sql } from 'drizzle-orm'
import type { Client } from 'pg'
import { rawDb, type Db, type RawDb } from './client.ts'
import type { TenantScope } from './tenancy.ts'

export type Tx = Parameters<Parameters<RawDb['transaction']>[0]>[0]

/** A tenant transaction was asked to start where it can't own its transaction, or without a tenant. */
export class TenantTransactionError extends Error {
  override name = 'TenantTransactionError'
}

/** pg's own queue (pg 8; not public API). Missing fields mean an unknown client: refused. */
type PgClient = Partial<Pick<Client, 'getTransactionStatus'>> & {
  _queryQueue?: unknown[]
  _getActiveQuery?: () => unknown
}

/** Clients with a tenant transaction in progress, claimed before the first await. */
const owned = new WeakSet<object>()

/**
 * Runs `fn` in a transaction this call owns (ADR-0040). Refuses unless the client is idle with
 * nothing queued or running and no tenant transaction already claimed it: a nested top-level
 * transaction would commit the outer one early, a savepoint would leak the tenant context into
 * it, and a concurrent one would share it. The status comes from the last ReadyForQuery and the
 * queue is local, so the check costs no round trip.
 */
export async function ownTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const raw = rawDb(db)
  // A Pool has none of these (and no single connection to own): refused.
  const client = (raw as unknown as { $client: PgClient }).$client
  const status = client.getTransactionStatus?.()
  const busy =
    !Array.isArray(client._queryQueue) ||
    client._queryQueue.length > 0 ||
    typeof client._getActiveQuery !== 'function' ||
    client._getActiveQuery() != null
  if (status !== 'I' || busy || owned.has(client)) {
    throw new TenantTransactionError(`a tenant transaction can't start here (status ${status})`)
  }
  owned.add(client)
  try {
    return await raw.transaction(fn)
  } finally {
    owned.delete(client)
  }
}

/**
 * Sets the transaction's tenant (`app.org_id`, transaction-local: gone at COMMIT or ROLLBACK).
 * The only place that calls `set_config` (lint-enforced).
 */
export async function enterTenant(tx: Tx, orgId: string): Promise<void> {
  if (!orgId) throw new TenantTransactionError('no tenant')
  await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`)
}

/** Runs `fn` in its own transaction with `scope`'s tenant set. Every tenant-table statement goes here. */
export function inTenant<T>(db: Db, scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!scope.orgId) return Promise.reject(new TenantTransactionError('no tenant'))
  return ownTransaction(db, async (tx) => {
    await enterTenant(tx, scope.orgId)
    return fn(tx)
  })
}
