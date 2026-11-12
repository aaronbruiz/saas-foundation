// Diagnostics for the Polar sandbox eval (ADR-0043/0044 release gates). A failure there can carry
// checkout and portal links (session credentials), emails or provider response bodies, so what
// leaves these helpers is only validated identifiers and integer HTTP statuses: never a message,
// a stack line or any other text from the error.

type Errorish = {
  name?: unknown
  statusCode?: unknown
  status?: unknown
  cause?: unknown
  stack?: unknown
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,39}$/
/** How many wrapped errors (`cause`) a summary follows below the error itself. */
const MAX_CAUSES = 3

const statusOf = (e: unknown) =>
  [(e as Errorish)?.statusCode, (e as Errorish)?.status].find(
    (v): v is number => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 599,
  )

/** `Name (HTTP n) ← Name ← …`: the error and up to three causes, identifiers and statuses only. */
export function errorSummary(e: unknown): string {
  const parts: string[] = []
  let current: unknown = e
  for (let depth = 0; depth <= MAX_CAUSES && current != null; depth++) {
    const err = current as Errorish
    const name = typeof err.name === 'string' && IDENTIFIER.test(err.name) ? err.name : 'Error'
    const status = statusOf(current)
    parts.push(status ? `${name} (HTTP ${status})` : name)
    current = typeof current === 'object' ? err.cause : undefined
  }
  // A rejection with nothing in it (null, undefined) still gets an identifier.
  return parts.length ? parts.join(' ← ') : 'Error'
}

/** The numeric line:column of the first frame in the eval test file (a frame can repeat text). */
export function testLine(e: unknown): string {
  const stack = (e as Errorish)?.stack
  for (const l of typeof stack === 'string' ? stack.split('\n') : []) {
    const m = /^\s+at .*polar-provider\.test\.ts:(\d+):(\d+)\)?$/.exec(l)
    if (m) return `${m[1]}:${m[2]}`
  }
  return 'unknown'
}

/** Runs a test body so any failure reports only its summary and line. */
export const scrubbed = (body: () => Promise<void>) => async () => {
  try {
    await body()
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error -- a cause would print the details hidden here
    throw new Error(`${errorSummary(e)} at line ${testLine(e)}; details hidden`)
  }
}

/** The run stopped on purpose; the sandbox is left as it is until the owner authorizes cleanup. */
export class StoppedWithoutCleanup extends Error {
  name = 'StoppedWithoutCleanup'
}
/** The run's customer already exists: a fresh run builds on nothing left by an earlier attempt. */
export class LeftoverCustomer extends Error {
  name = 'LeftoverCustomer'
}
/** A removal whose outcome isn't proven: it failed, or the object is still there. */
export class CleanupUnknown extends Error {
  name = 'CleanupUnknown'
}

/** The lookup's value, or null only on the provider's 404; any other failure propagates. */
export async function lookupOrNull<T>(lookup: () => Promise<T>): Promise<T | null> {
  try {
    return await lookup()
  } catch (e) {
    if (statusOf(e) === 404) return null
    throw e
  }
}

/**
 * Waits for every call, so none is still in flight when the caller goes on, and reports each as
 * `created` or its summary.
 */
export async function settleAll<T>(calls: Promise<T>[]) {
  const settled = await Promise.allSettled(calls)
  return {
    values: settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    outcomes: settled.map((r) => (r.status === 'fulfilled' ? 'created' : errorSummary(r.reason))),
    failed: settled.some((r) => r.status === 'rejected'),
  }
}

/**
 * Removes an object and proves the outcome by looking it up: `absent` (404 before), `deleted`
 * (present, then 404). Anything else, including a failed lookup or removal, is CleanupUnknown.
 */
export async function removeVerified(
  lookup: () => Promise<unknown>,
  remove: () => Promise<void>,
): Promise<'absent' | 'deleted'> {
  const step = async <T>(f: () => Promise<T>) => {
    try {
      return await f()
    } catch (e) {
      throw new CleanupUnknown('cleanup outcome unknown', { cause: e })
    }
  }
  if ((await step(() => lookupOrNull(lookup))) === null) return 'absent'
  await step(remove)
  if ((await step(() => lookupOrNull(lookup))) !== null)
    throw new CleanupUnknown('still present after the removal')
  return 'deleted'
}
