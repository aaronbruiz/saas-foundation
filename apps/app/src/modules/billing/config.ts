import { env } from 'cloudflare:workers'
import {
  MemberWriteUnknown,
  ProviderUnavailable,
  type BillingMembers,
  type BillingProvider,
  type WebhookParser,
} from './provider'
import {
  polarMembers,
  polarProvider,
  polarWebhookParser,
  type PolarConfig,
} from './providers/polar'

/** For the billing access gate (ADR-0044): this write's outcome at the provider isn't known. */
export const isMemberWriteUnknown = (e: unknown) => e instanceof MemberWriteUnknown

// Which provider is configured, from Worker secrets and vars. Kept apart from service.ts so
// server/auth.ts can wire the member sync without importing the service (which imports the tenant
// context, which imports auth).

/**
 * ADR-0022: Polar mode is explicit (`BILLING_PROVIDER=polar`), never inferred from a token, so a
 * missing token can't silently turn off the member sync for customers that already exist.
 */
const polarMode = () => env.BILLING_PROVIDER === 'polar'

/** `POLAR_SERVER` defaults to the sandbox. */
const polarConfig = (): PolarConfig | null =>
  env.POLAR_ACCESS_TOKEN
    ? {
        accessToken: env.POLAR_ACCESS_TOKEN,
        server: env.POLAR_SERVER === 'production' ? 'production' : 'sandbox',
      }
    : null

/** The configured provider, or null (local dev, previews): billing actions then answer 503. */
export const configuredProvider = (): BillingProvider | null => {
  const polar = polarMode() ? polarConfig() : null
  return polar && polarProvider(polar)
}

/** In Polar mode without a token, owner changes are refused rather than left unsynced. */
const unavailableMembers: BillingMembers = {
  revoke: async () => {
    throw new ProviderUnavailable('POLAR_ACCESS_TOKEN missing')
  },
  grant: async () => {},
  removeAccount: async () => {
    throw new ProviderUnavailable('POLAR_ACCESS_TOKEN missing')
  },
}

/** Member sync in Polar mode, or null (providers without their own billing logins). */
export const configuredMembers = (): BillingMembers | null => {
  if (!polarMode()) return null
  const polar = polarConfig()
  return polar ? polarMembers(polar) : unavailableMembers
}

/** Outside Polar mode the Polar endpoint accepts nothing (503), whatever secret is configured. */
const notPolarMode: WebhookParser = async () => {
  throw new ProviderUnavailable('BILLING_PROVIDER is not polar')
}

/** The Polar webhook parser: re-reads subscriptions (see polarWebhookParser); Polar mode only. */
export const polarWebhook = (): WebhookParser =>
  polarMode() ? polarWebhookParser(polarConfig() ?? 'unconfigured') : notPolarMode
