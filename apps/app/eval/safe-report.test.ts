// Offline: the sandbox eval's diagnostics, with synthetic errors and fake provider calls. No network.
import { describe, expect, it } from 'vitest'
import {
  CleanupUnknown,
  errorSummary,
  lookupOrNull,
  removeVerified,
  scrubbed,
  settleAll,
} from './safe-report'

const SECRET = /FAKE|example\.invalid|https?:|polar_|token/
const httpError = (name: string, status: unknown, message = 'FAKE https://x polar_oat_FAKE') =>
  Object.assign(new Error(message), { name, statusCode: status })
const wrapped = (name: string, cause: unknown) =>
  Object.assign(new Error('FAKE a@example.invalid', { cause }), { name })

describe('error summary', () => {
  it('names a wrapped chain with integer statuses only, never a message', () => {
    const e = wrapped(
      'CheckoutNotCreated',
      wrapped('MemberWriteUnknown', httpError('SDKError', 403)),
    )
    expect(errorSummary(e)).toBe('CheckoutNotCreated ← MemberWriteUnknown ← SDKError (HTTP 403)')
  })

  it('replaces a name that is not a plain identifier, and ignores a status that is not an integer', () => {
    const e = httpError('Bad name FAKE', '500 FAKE')
    expect(errorSummary(e)).toBe('Error')
    expect(errorSummary(httpError('X', 99))).toBe('X')
    expect(errorSummary(httpError('X', 600))).toBe('X')
  })

  it('follows at most three causes, and survives non-object throws and cycles', () => {
    let e: unknown = httpError('L4', 500)
    for (const n of ['L3', 'L2', 'L1', 'L0']) e = wrapped(n, e)
    expect(errorSummary(e)).toBe('L0 ← L1 ← L2 ← L3')
    expect(errorSummary('FAKE string')).toBe('Error')
    expect(errorSummary(null)).toBe('Error')
    expect(errorSummary(undefined)).toBe('Error')
    const loop = wrapped('Loop', undefined) as Error & { cause?: unknown }
    loop.cause = loop
    expect(errorSummary(loop)).toBe('Loop ← Loop ← Loop ← Loop')
  })

  it('a scrubbed failure carries the summary and a numeric line, nothing else', async () => {
    const e = wrapped('CheckoutNotCreated', httpError('SDKError', 422))
    e.stack = `Error: FAKE\n    at x polar-provider.test.ts@FAKE\n    at y (/a/eval/polar-provider.test.ts:102:30)`
    const thrown = await scrubbed(async () => {
      throw e
    })().then(
      () => new Error('did not throw'),
      (x: Error) => x,
    )
    expect(thrown.message).toBe(
      'CheckoutNotCreated ← SDKError (HTTP 422) at line 102:30; details hidden',
    )
    expect(SECRET.test(thrown.message)).toBe(false)
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined()
  })
})

describe('both checkouts', () => {
  it('waits for the slower call after the other fails, and reports both', async () => {
    let finishSlow!: (v: string) => void
    const slow = new Promise<string>((r) => (finishSlow = r))
    let settled = false
    const pair = settleAll([Promise.reject(httpError('SDKError', 403)), slow]).then((p) => {
      settled = true
      return p
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    finishSlow('url')
    const result = await pair
    expect(result.failed).toBe(true)
    expect(result.outcomes).toEqual(['SDKError (HTTP 403)', 'created'])
    expect(result.values).toEqual(['url'])
  })

  it('reports an unknown outcome (no status) the same way', async () => {
    const result = await settleAll([Promise.resolve('a'), Promise.reject(new TypeError('FAKE'))])
    expect(result).toMatchObject({ failed: true, outcomes: ['created', 'TypeError'] })
  })

  it('a rejection with no error in it still reports an identifier', async () => {
    const result = await settleAll([Promise.reject(null), Promise.resolve('a')])
    expect(result.outcomes).toEqual(['Error', 'created'])
    expect(result.failed).toBe(true)
  })

  it('passes both values through when both are created', async () => {
    expect(await settleAll([Promise.resolve('a'), Promise.resolve('b')])).toEqual({
      values: ['a', 'b'],
      outcomes: ['created', 'created'],
      failed: false,
    })
  })
})

describe('lookups and cleanup', () => {
  const gone = () => Promise.reject(httpError('ResourceNotFound', 404))
  const down = () => Promise.reject(httpError('SDKError', 503))

  it('only a 404 reads as absent', async () => {
    expect(await lookupOrNull(gone)).toBeNull()
    expect(await lookupOrNull(() => Promise.resolve('c'))).toBe('c')
    await expect(lookupOrNull(down)).rejects.toMatchObject({ statusCode: 503 })
    await expect(lookupOrNull(() => Promise.reject(httpError('SDKError', 401)))).rejects.toThrow()
  })

  it('absent before: nothing removed', async () => {
    let removed = 0
    expect(await removeVerified(gone, async () => void removed++)).toBe('absent')
    expect(removed).toBe(0)
  })

  it('deleted only when the lookup answers 404 afterwards', async () => {
    let present = true
    const lookup = () => (present ? Promise.resolve('c') : gone())
    expect(await removeVerified(lookup, async () => void (present = false))).toBe('deleted')
  })

  it('a failed lookup, a failed removal, or an object still there is CleanupUnknown', async () => {
    const still = () => Promise.resolve('c')
    for (const [lookup, remove] of [
      [down, async () => {}],
      [still, () => Promise.reject(httpError('SDKError', 500))],
      [still, async () => {}],
    ] as const) {
      const e = await removeVerified(lookup, remove).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(CleanupUnknown)
    }
    const e = await removeVerified(still, () => Promise.reject(httpError('SDKError', 500))).catch(
      (x: unknown) => x,
    )
    expect(errorSummary(e)).toBe('CleanupUnknown ← SDKError (HTTP 500)')
  })

  it('a removal that ran but whose check then fails is CleanupUnknown, not deleted', async () => {
    let calls = 0
    const lookup = () => (calls++ === 0 ? Promise.resolve('c') : down())
    let removed = 0
    const e = await removeVerified(lookup, async () => void removed++).catch((x: unknown) => x)
    expect(removed).toBe(1)
    expect(errorSummary(e)).toBe('CleanupUnknown ← SDKError (HTTP 503)')
  })
})
