/** Errors with an HTTP meaning. 404 for anything outside the caller's tenant (AGENTS.md invariant 5). */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const notFound = () => new HttpError(404, 'not found')

/** Validates input against a Zod schema; failures become 400 (never a partial parse). */
export function parseInput<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  input: unknown,
): T {
  const r = schema.safeParse(input)
  if (!r.success) throw new HttpError(400, 'invalid input')
  return r.data
}
