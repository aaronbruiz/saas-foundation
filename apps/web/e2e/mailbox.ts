import { readFileSync } from 'node:fs'
import { createEmailVerificationToken } from 'better-auth/api'
import { verifiedLoginUrl } from '../src/lib/safe-redirect'

/**
 * E2E mailbox (ADR-0016). Verification links are JWTs signed with BETTER_AUTH_SECRET, so the test
 * runner signs the same link the email would carry and the browser follows it through the real
 * `/api/auth/verify-email`. The secret stays in this Node process (read from the local dev server's
 * `.dev.vars`); it never reaches a page, fixture or client variable.
 *
 * Previews (`BASE_URL` set) run with verification off: they send no email, and their e2e job holds
 * no secret.
 */
export const verifiesEmail = !process.env.BASE_URL

let secret: string | undefined
function authSecret(): string {
  if (secret) return secret
  const line = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('BETTER_AUTH_SECRET='))
  secret = line
    ?.slice('BETTER_AUTH_SECRET='.length)
    .trim()
    .replace(/^"(.*)"$/, '$1')
  if (!secret) throw new Error('BETTER_AUTH_SECRET missing from apps/web/.dev.vars')
  return secret
}

/** The verification link sent to `email` after signing up from a page with `?redirect=target`. */
export async function verificationLink(email: string, target: string | null): Promise<string> {
  const token = await createEmailVerificationToken(authSecret(), email)
  const query = new URLSearchParams({ token, callbackURL: verifiedLoginUrl(target ?? '/') })
  return `/api/auth/verify-email?${query}`
}
