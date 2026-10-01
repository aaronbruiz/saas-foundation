import { createServerFn } from '@tanstack/react-start'
import { turnstileSiteKey } from './auth'

/**
 * ADR-0025: the public Turnstile site key for the auth pages, read per request so one build serves
 * every environment. Null while bot protection is unavailable (the forms then stay disabled).
 */
export const getTurnstileSiteKeyFn = createServerFn({ method: 'GET' }).handler(() =>
  turnstileSiteKey(),
)
