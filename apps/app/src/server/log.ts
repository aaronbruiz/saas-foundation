/**
 * Structured logs for Workers Logs (ADR-0015): one JSON object per line, searchable by `event`.
 * Never pass request bodies, headers, cookies, tokens, connection strings or user data as fields.
 * Error messages are redacted defensively and truncated, since library errors can embed input
 * values. Redaction is best effort (it can't recognize a name, say); prefer `code` and `event` over
 * message text when adding new logs.
 */
import { HttpError } from './errors'

type Fields = Record<string, string | number | boolean | undefined>

const MAX_MESSAGE = 300
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
const AUTH_SCHEME = /\b(bearer|basic)\s+[^\s"',;]+/gi
// Also compound and camelCase keys (client_secret, access_token, refreshToken, x-api-key,
// authCode), quoted keys (JSON) and quoted or bare values.
const SECRET_PAIR =
  /\b([A-Za-z0-9_-]*?(?:password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|session[_-]?id|code))(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&}]+)/gi
const redactValue = (_: string, key: string, sep: string, value: string) =>
  `${key}${sep}${/^["']/.test(value) ? `${value[0]}[redacted]${value[0]}` : '[redacted]'}`
const QUERY = /\?[^\s"']*/g
// Long opaque strings (tokens, keys, ids used as capabilities).
const OPAQUE = /\b[A-Za-z0-9_-]{32,}\b/g

export const redact = (text: string) =>
  text
    .slice(0, MAX_MESSAGE)
    .replace(URL_CREDENTIALS, '$1[redacted]@')
    .replace(AUTH_SCHEME, '$1 [redacted]')
    .replace(SECRET_PAIR, redactValue)
    .replace(QUERY, '?[redacted]')
    .replace(EMAIL, '[email]')
    .replace(OPAQUE, '[redacted]')

function describe(err: unknown) {
  if (!(err instanceof Error)) return { name: typeof err }
  const code = (err as { code?: unknown }).code
  return {
    name: redact(err.name),
    message: redact(err.message),
    ...(typeof code === 'number'
      ? { code }
      : typeof code === 'string'
        ? { code: redact(code) }
        : {}),
  }
}

export function logError(event: string, err: unknown, fields: Fields = {}) {
  console.error(JSON.stringify({ level: 'error', event, ...fields, error: describe(err) }))
}

export function logWarn(event: string, fields: Fields = {}) {
  console.warn(JSON.stringify({ level: 'warn', event, ...fields }))
}

/** Expected client errors: our HttpErrors and library 4xx errors (e.g. Better Auth's APIError). */
const isClientError = (e: unknown) => {
  if (e instanceof HttpError) return true
  const status = (e as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' && status >= 400 && status < 500
}

/** Logs `err` unless it's an expected client error. Returns whether it logged. */
export function logUnexpected(event: string, err: unknown, fields: Fields = {}): boolean {
  if (isClientError(err)) return false
  logError(event, err, fields)
  return true
}

/** What a client sees for an unexpected error: only an error's message reaches the browser (R01). */
export const UNEXPECTED_MESSAGE = 'Something went wrong. Please try again.'

/**
 * Logs `err` unless it's an expected client error, then returns what the client may receive: an
 * expected error as it is (its message is for the user), anything else as a generic error, since a
 * library message can carry internal detail (ADR-0015).
 */
export function forClient(event: string, err: unknown, fields: Fields = {}): unknown {
  return logUnexpected(event, err, fields) ? new Error(UNEXPECTED_MESSAGE) : err
}

/**
 * Better Auth's own log lines. It sometimes passes an Error (or other value) instead of a string;
 * only a redacted name/message is kept either way. Stable `auth.*` names from our auth package
 * (e.g. `auth.captcha_unavailable`, ADR-0025) become the event.
 */
export function logBetterAuth(level: 'debug' | 'info' | 'warn' | 'error', message: unknown) {
  const text =
    typeof message === 'string'
      ? message
      : message instanceof Error
        ? `${message.name}: ${message.message}`
        : `non-string log message (${typeof message})`
  const line = JSON.stringify(
    /^auth\.[a-z_]+$/.test(text)
      ? { level, event: text }
      : { level, event: 'better_auth', message: redact(text) },
  )
  if (level === 'error') console.error(line)
  else console.warn(line)
}
