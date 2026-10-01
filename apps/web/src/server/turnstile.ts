import { createServerFn } from '@tanstack/react-start'
import { BOT_PROTECTION_ACTIONS } from '@saas-foundation/auth'
import { turnstileSiteKey } from './auth'

/**
 * ADR-0025: what the auth pages' Turnstile widgets render with, read per request so one build
 * serves every environment: the public site key (null while bot protection is unavailable; the
 * forms then stay disabled) and the action each protected endpoint expects.
 */
export const getTurnstileConfigFn = createServerFn({ method: 'GET' }).handler(() => ({
  siteKey: turnstileSiteKey(),
  actions: BOT_PROTECTION_ACTIONS,
}))
