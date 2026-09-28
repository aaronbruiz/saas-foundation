/** Errors with an HTTP meaning. 404 for anything outside the caller's tenant (AGENTS.md invariant 5). */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const notFound = () => new HttpError(404, 'not found')

type Issue = { path: PropertyKey[] }
type Schema<T> = {
  safeParse: (
    v: unknown,
  ) => { success: true; data: T } | { success: false; error: { issues: Issue[] } }
}

/**
 * Validates input against a Zod contract; never a partial parse. An invalid `tenant` selector is
 * a 404 like any unknown tenant (invariant 5); any other invalid input is a 400.
 */
export function parseInput<T>(schema: Schema<T>, input: unknown): T {
  const r = schema.safeParse(input)
  if (r.success) return r.data
  if (r.error.issues.some((i) => i.path[0] === 'tenant')) throw notFound()
  throw new HttpError(400, 'invalid input')
}
