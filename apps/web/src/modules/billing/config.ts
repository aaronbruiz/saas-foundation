import { env } from 'cloudflare:workers'
import type { BillingMembers, BillingProvider } from './provider'
import { polarMembers, polarProvider, type PolarConfig } from './providers/polar'
import { stripeProvider } from './providers/stripe'

// Which provider is configured, from Worker secrets and vars. Kept apart from service.ts so
// server/auth.ts can wire the member sync without importing the service (which imports the tenant
// context, which imports auth).

const vars = env as unknown as {
  POLAR_ACCESS_TOKEN?: string
  POLAR_SERVER?: string
  STRIPE_SECRET_KEY?: string
}

/** ADR-0022: Polar when its token is set; `POLAR_SERVER` defaults to the sandbox. */
const polarConfig = (): PolarConfig | null =>
  vars.POLAR_ACCESS_TOKEN
    ? {
        accessToken: vars.POLAR_ACCESS_TOKEN,
        server: vars.POLAR_SERVER === 'production' ? 'production' : 'sandbox',
      }
    : null

/** The configured provider, or null (local dev, previews): billing actions then answer 503. */
export const configuredProvider = (): BillingProvider | null => {
  const polar = polarConfig()
  if (polar) return polarProvider(polar)
  return vars.STRIPE_SECRET_KEY ? stripeProvider(vars.STRIPE_SECRET_KEY) : null
}

/** Member sync for a provider with its own billing logins (Polar), or null. */
export const configuredMembers = (): BillingMembers | null => {
  const polar = polarConfig()
  return polar && polarMembers(polar)
}
