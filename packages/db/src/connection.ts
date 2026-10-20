import { AsyncLocalStorage } from 'node:async_hooks'
import { Client } from 'pg'

/** A tenant transaction was asked to start where it can't own the connection, or something else used it. */
export class TenantTransactionError extends Error {
  override name = 'TenantTransactionError'
}

/** One tenant transaction's claim on a connection. Dead once the transaction has ended. */
export type Owner = { live: boolean; tenantSet: boolean }

const owners = new AsyncLocalStorage<Owner>()

/** pg 8 state read by `claim` (not public API; checked against pg 8.23.1, ADR-0040). */
type PgState = {
  readyForQuery?: boolean
  pipeline?: boolean
  _queryQueue?: unknown[]
  _getActiveQuery?: () => unknown
}

// Outside the owner's control path no statement may set or reset the tenant context. Inside the
// owner, only single plain statements run: nothing that ends, nests or reconfigures the transaction.
const SETS_CONTEXT = /set_config|\b(set|reset)\b[\s\S]*\bapp\b["\s]*\./i
const CONTROL =
  /^(begin|start|commit|end|rollback|abort|savepoint|release|prepare|set|reset|discard|do|call|listen|unlisten|notify|lock|copy)\b/i
const LEADING_NOISE = /^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/

const textOf = (config: unknown): string | undefined =>
  typeof config === 'string'
    ? config
    : typeof (config as { text?: unknown } | null)?.text === 'string'
      ? (config as { text: string }).text
      : undefined

/**
 * The only pg client `createDb` makes (ADR-0040). Every statement, from our repositories, Better
 * Auth's adapter or raw Drizzle, goes through `query`, which refuses it before pg queues anything
 * when a tenant transaction owns the connection and the caller isn't running inside that
 * transaction's async context, or when it would set the tenant context outside the owner's path.
 */
export class GuardedClient extends Client {
  #owner: Owner | null = null
  #broken = false

  // pg's overloads; the gate only reads the statement text.
  override query(...args: unknown[]): never {
    this.#gate(args[0])
    return (Client.prototype.query as (...a: unknown[]) => never).apply(this, args)
  }

  #gate(config: unknown) {
    if (this.#broken)
      throw new TenantTransactionError('connection unusable after a failed tenant transaction')
    const current = owners.getStore()
    if (current && !current.live)
      throw new TenantTransactionError('tenant transaction already ended')
    const text = textOf(config)
    if (text === undefined || SETS_CONTEXT.test(text)) {
      throw new TenantTransactionError('statement refused: it may set the tenant context')
    }
    if (!this.#owner) return
    if (current !== this.#owner)
      throw new TenantTransactionError('connection owned by a tenant transaction')
    if (CONTROL.test(text.replace(LEADING_NOISE, '')) || text.includes(';')) {
      throw new TenantTransactionError('statement refused inside a tenant transaction')
    }
  }

  /**
   * Runs `fn` as the owner of this connection, inside `BEGIN … COMMIT` (ROLLBACK on failure).
   * Claimed synchronously, before anything is awaited; refused unless the connection is idle with
   * nothing queued, running or awaiting ReadyForQuery. Released after the transaction ends on every
   * path; a connection whose transaction didn't end cleanly refuses everything afterwards.
   */
  runOwned<T>(fn: () => Promise<T>): Promise<T> {
    const pg = this as unknown as PgState
    const busy =
      this.#broken ||
      this.#owner !== null ||
      pg.pipeline !== false ||
      pg.readyForQuery !== true ||
      !Array.isArray(pg._queryQueue) ||
      pg._queryQueue.length > 0 ||
      typeof pg._getActiveQuery !== 'function' ||
      pg._getActiveQuery() != null ||
      this.getTransactionStatus() !== 'I'
    // Also refused from inside any tenant transaction's async context, live or ended.
    if (busy || owners.getStore() !== undefined) {
      return Promise.reject(
        new TenantTransactionError(
          `a tenant transaction can't start here (status ${this.getTransactionStatus()})`,
        ),
      )
    }
    const owner: Owner = { live: true, tenantSet: false }
    this.#owner = owner
    return owners.run(owner, async () => {
      let open = false
      try {
        await this.#control('BEGIN')
        open = true
        const result = await fn()
        open = false
        await this.#control('COMMIT')
        return result
      } catch (error) {
        if (open) await this.#control('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        owner.live = false
        this.#owner = null
        if (this.getTransactionStatus() !== 'I') this.#broken = true
      }
    })
  }

  /**
   * Sets the owner's tenant (`app.org_id`) once, transaction-locally: gone at COMMIT or ROLLBACK.
   * Only for the running owner. The only place that sets the tenant context (lint-enforced).
   */
  setTenant(orgId: string): Promise<unknown> {
    const current = owners.getStore()
    if (!current || current !== this.#owner || !current.live || current.tenantSet) {
      return Promise.reject(new TenantTransactionError('the tenant can be set once, by its owner'))
    }
    current.tenantSet = true
    return this.#control(`select set_config('app.org_id', $1, true)`, [orgId])
  }

  #control(text: string, values?: unknown[]): Promise<unknown> {
    return (Client.prototype.query as (t: string, v?: unknown[]) => Promise<unknown>).call(
      this,
      text,
      values,
    )
  }
}
