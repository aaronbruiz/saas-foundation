/**
 * Structured logs for Workers Logs (ADR-0015): one JSON object per line, searchable by `event`.
 * Never pass request bodies, headers, cookies, tokens, connection strings or user data as fields.
 * Error messages are redacted defensively (emails, credentials in URLs), since library errors can
 * embed input values.
 */
import { HttpError } from './errors'

type Fields = Record<string, string | number | boolean | undefined>

const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi

export const redact = (text: string) =>
  text.replace(URL_CREDENTIALS, '$1[redacted]@').replace(EMAIL, '[email]')

function describe(err: unknown) {
  if (!(err instanceof Error)) return { name: typeof err }
  const code = (err as { code?: unknown }).code
  return {
    name: err.name,
    message: redact(err.message),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  }
}

export function logError(event: string, err: unknown, fields: Fields = {}) {
  console.error(JSON.stringify({ level: 'error', event, ...fields, error: describe(err) }))
}

export function logWarn(event: string, fields: Fields = {}) {
  console.warn(JSON.stringify({ level: 'warn', event, ...fields }))
}

/** Expected client errors: our HttpErrors and library 4xx errors (e.g. Better Auth's APIError). */
const isClientError = (e: unknown) =>
  e instanceof HttpError ||
  (typeof (e as { statusCode?: unknown } | null)?.statusCode === 'number' &&
    (e as { statusCode: number }).statusCode < 500)

/** Logs `err` unless it's an expected client error. Returns whether it logged. */
export function logUnexpected(event: string, err: unknown, fields: Fields = {}): boolean {
  if (isClientError(err)) return false
  logError(event, err, fields)
  return true
}
