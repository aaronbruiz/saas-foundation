// The site's product facts (ADR-0033). Template values: a product built on this starter replaces
// them (runbook "Start a new product"), together with apps/app's `legalEntity` and wrangler names.

/** ADR-0033 decision 5: what the calls to action offer. `allowlist` while sign-up is allowlisted
 * (ADR-0032); `open` once public sign-up (milestone D, its own ADR) is live. The site can't read
 * the app's SIGNUP_MODE: change this with that decision. */
export type SignupMode = 'allowlist' | 'open'

export const site = {
  product: 'SaaS Foundation',
  tagline: 'Projects for your whole team, one workspace per organization.',
  description:
    'SaaS Foundation gives every organization its own workspace for projects and members, with roles, invitations and plans that grow with the team.',
  appUrl: 'https://app.aaronlabr.dev',
  docsUrl: 'https://docs.aaronlabr.dev',
  /** Where "Request access" and support questions go; route it before the first deploy (runbook "Site"). */
  contactEmail: 'hello@aaronlabr.dev',
  signupMode: 'allowlist' as SignupMode,
}

export const appLink = (path: `/${string}`) => new URL(path, site.appUrl).href

export const legalLinks = [
  { label: 'Privacy', href: appLink('/privacy') },
  { label: 'Terms', href: appLink('/terms') },
  { label: 'Subprocessors', href: appLink('/subprocessors') },
]

/** The primary call to action for the current sign-up mode (ADR-0033 decision 5). */
export const primaryAction =
  site.signupMode === 'open'
    ? { label: 'Get started', href: appLink('/signup') }
    : {
        label: 'Request access',
        href: `mailto:${site.contactEmail}?subject=${encodeURIComponent(`${site.product} access`)}`,
      }

export const signIn = { label: 'Sign in', href: appLink('/login') }
