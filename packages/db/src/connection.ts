import { AsyncLocalStorage } from 'node:async_hooks'
import { Client } from 'pg'

/** A tenant transaction was asked to start where it can't own the connection, or something else used it. */
export class TenantTransactionError extends Error {
  override name = 'TenantTransactionError'
}

/** One tenant transaction's claim on a connection. Dead once the transaction has ended. */
export type Owner = { live: boolean; tenantSet: boolean; timedOut?: boolean }

// pg's `query_timeout` rejects with this message without cancelling the statement (pg 8.23.1).
const isTimeout = (error: unknown) => (error as Error | null)?.message === 'Query read timeout'

const owners = new AsyncLocalStorage<Owner>()

/** pg 8 state read by `claim` (not public API; checked against pg 8.23.1, ADR-0040). */
type PgState = {
  readyForQuery?: boolean
  pipeline?: boolean
  _queryQueue?: unknown[]
  _getActiveQuery?: () => unknown
}

// Defense in depth, not the boundary (ADR-0040): text checks can't parse PostgreSQL. Outside an
// owner, statements that visibly set the tenant context are refused. Inside one, only a single
// plain query or write of the kind Drizzle generates runs: no comments, no second statement, no
// Unicode-escaped identifiers, no dollar quoting, no setters.
const SETS_CONTEXT = /set_config|\b(set|reset)\b[\s\S]*\bapp\b["\s]*\./i
const PLAIN = /^\s*(select|insert|update|delete|with)\s/i
const UNCHECKABLE = /\/\*|--|;|\bu&|\$(?!\d)|set_config|pg_settings/i

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
    // A statement reported as timed out may still finish and write, so its transaction must not
    // commit (`runOwned` checks this), even if the caller catches the timeout.
    const owner = this.#owner
    const last = args.length - 1
    const callback = args[last]
    if (owner && typeof callback === 'function') {
      args[last] = (error: unknown, ...rest: unknown[]) => {
        if (isTimeout(error)) owner.timedOut = true
        return (callback as (...a: unknown[]) => unknown)(error, ...rest)
      }
    }
    const result = (Client.prototype.query as (...a: unknown[]) => unknown).apply(this, args)
    if (owner && result instanceof Promise) {
      result.catch((error: unknown) => {
        if (isTimeout(error)) owner.timedOut = true
      })
    }
    return result as never
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
    if (!PLAIN.test(text) || UNCHECKABLE.test(text)) {
      throw new TenantTransactionError('statement refused inside a tenant transaction')
    }
  }

  /**
   * Runs `fn` as the owner of this connection, inside `BEGIN … COMMIT` (ROLLBACK on failure).
   * Claimed synchronously, before anything is awaited; refused unless the connection is idle with
   * nothing queued, running or awaiting ReadyForQuery. The owner's admission closes the moment `fn`
   * settles, before COMMIT or ROLLBACK is queued, so nothing it started can run after them; if its
   * statements are still pending then, or the transaction isn't open and healthy, it rolls back
   * (fail closed). Released only after the transaction has ended; a connection that isn't idle then
   * refuses everything afterwards.
   */
  runOwned<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busy() || owners.getStore() !== undefined) {
      // Also refused from inside any tenant transaction's async context, live or ended.
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
        let result: T
        try {
          result = await fn()
        } finally {
          owner.live = false
        }
        const status = this.getTransactionStatus()
        if (owner.timedOut)
          throw new TenantTransactionError('a statement in the tenant transaction timed out')
        if (this.#pending() || status !== 'T') {
          throw new TenantTransactionError(
            this.#pending()
              ? 'statements still running when the tenant transaction body finished'
              : `tenant transaction no longer open (status ${status})`,
          )
        }
        open = false
        const done = (await this.#control('COMMIT')) as { command?: string }
        if (done.command !== 'COMMIT')
          throw new TenantTransactionError('tenant transaction did not commit')
        return result
      } catch (error) {
        if (open) await this.#control('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        owner.live = false
        this.#owner = null
        if (this.#busy()) this.#broken = true
      }
    })
  }

  /** pg has a statement queued, running or awaiting ReadyForQuery (missing state counts as pending). */
  #pending(): boolean {
    const pg = this as unknown as PgState
    return (
      pg.readyForQuery !== true ||
      !Array.isArray(pg._queryQueue) ||
      pg._queryQueue.length > 0 ||
      typeof pg._getActiveQuery !== 'function' ||
      pg._getActiveQuery() != null
    )
  }

  /** Not free for a new tenant transaction. */
  #busy(): boolean {
    return (
      this.#broken ||
      this.#owner !== null ||
      (this as unknown as PgState).pipeline !== false ||
      this.#pending() ||
      this.getTransactionStatus() !== 'I'
    )
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
