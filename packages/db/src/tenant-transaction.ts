import { sql } from 'drizzle-orm'
import type { Client } from 'pg'
import { rawDb, type Db, type RawDb } from './client.ts'
import type { TenantScope } from './tenancy.ts'

export type Tx = Parameters<Parameters<RawDb['transaction']>[0]>[0]

/** A tenant transaction was asked to start where it can't own its transaction, or without a tenant. */
export class TenantTransactionError extends Error {
  override name = 'TenantTransactionError'
}

/**
 * Runs `fn` in a transaction this call owns (ADR-0040). Refuses when the client is already in a
 * transaction: a nested top-level transaction would commit the outer one early, and a savepoint
 * would leak the tenant context into it. The status comes from the last ReadyForQuery, so the
 * check costs no round trip.
 */
export async function ownTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const raw = rawDb(db)
  // A Pool has no status (and no single connection to own): undefined, refused.
  const { $client } = raw as unknown as { $client: Partial<Pick<Client, 'getTransactionStatus'>> }
  const status = $client.getTransactionStatus?.()
  if (status !== 'I') {
    throw new TenantTransactionError(`a tenant transaction can't start here (status ${status})`)
  }
  return raw.transaction(fn)
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
