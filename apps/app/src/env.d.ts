// Optional Worker vars and secrets. `wrangler types` only types the names in .dev.vars.example
// (worker-configuration.d.ts, generated); the rest are declared here once, so reading a name that
// is in neither fails tsc. Each feature still checks its own names and fails closed.
declare namespace Cloudflare {
  interface Env {
    SIGNUP_ALLOWLIST?: string
    EMAIL_VERIFICATION?: string
    EMAIL_FROM?: string
    BILLING_PROVIDER?: string
    POLAR_ACCESS_TOKEN?: string
    POLAR_SERVER?: string
    POLAR_WEBHOOK_SECRET?: string
  }
}
