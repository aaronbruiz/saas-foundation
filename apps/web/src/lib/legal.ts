// Legal documents' metadata and the subprocessor registry. The documents' text lives in their
// routes (`routes/privacy.tsx`, `routes/terms.tsx`) and is the owner's (or their lawyer's) to write.
// Earlier versions are in git history; this is not a record of what any user accepted.

export type LegalDocument = {
  title: string
  /** Bumped by the owner when the text changes. */
  version: string
  /** ISO date the version takes effect; `null` while the document is a draft. */
  effectiveDate: string | null
}

export const legalDocuments = {
  privacy: { title: 'Privacy Policy', version: '0', effectiveDate: null },
  terms: { title: 'Terms of Service', version: '0', effectiveDate: null },
  subprocessors: { title: 'Subprocessors', version: '0', effectiveDate: null },
} satisfies Record<string, LegalDocument>

export type Subprocessor = {
  name: string
  service: string
  /** What the service handles, as recorded in the ADRs. */
  data: string
  location: string
  /** Where each fact is recorded (for maintainers; not shown). */
  source: string
}

// Only facts recorded in the ADRs and `apps/web/wrangler.jsonc`; update with the ADR that changes them.
export const subprocessors: Subprocessor[] = [
  {
    name: 'Cloudflare',
    service: 'Application hosting (Workers) and request logs (Workers Logs)',
    data: "Every request to the application. Logs keep each request's path (query string removed), status and outcome, and redacted error messages; Issues group errors with their stack traces",
    location: "Cloudflare's network; the application runs near the database in AWS us-east-1",
    source: 'ADR-0002, ADR-0015, wrangler.jsonc (placement, observability)',
  },
  {
    name: 'Cloudflare',
    service: 'Database connection (Hyperdrive, caching disabled)',
    data: 'Database queries and results pass through; nothing is cached',
    location: 'Not recorded in the ADRs',
    source: 'ADR-0003, ADR-0004',
  },
  {
    name: 'Cloudflare',
    service:
      'Bot protection (Turnstile) on sign-up, sign-in, password reset and verification email',
    data: "The Turnstile token and the visitor's IP address, sent for verification",
    location: 'Not recorded in the ADRs',
    source: 'ADR-0025',
  },
  {
    name: 'Cloudflare',
    service: 'Transactional email (Email Service)',
    data: "Recipient's email address and message content (verification, password reset, invitation)",
    location: 'Not recorded in the ADRs',
    source: 'ADR-0016, ADR-0024',
  },
  {
    name: 'Cloudflare',
    service: 'Database backups (R2)',
    data: 'A daily full copy of the database, deleted after 30 days',
    location: 'Automatic (chosen by R2)',
    source: 'ADR-0023',
  },
  {
    name: 'Neon',
    service: 'Primary database (PostgreSQL)',
    data: 'All account and organization data',
    location: 'AWS us-east-1',
    source: 'ADR-0003',
  },
  {
    name: 'Polar Software, Inc.',
    service: 'Billing, as merchant of record (sandbox mode; no real payments yet)',
    data: "Organization id and name; billing managers' user ids and email addresses; the IP address of whoever starts a checkout; what the buyer enters in Polar's checkout",
    location: 'Not recorded in the ADRs',
    source: 'ADR-0022, modules/billing/service.ts and providers/polar.ts (customer_ip_address)',
  },
  {
    name: 'GitHub',
    service: 'Database backup job (GitHub Actions)',
    data: 'The daily database dump passes through the job on its way to R2',
    location: 'Not recorded in the ADRs',
    source: 'ADR-0023',
  },
]
