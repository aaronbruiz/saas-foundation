# Architecture Decision Records

One file per decision: `NNNN-kebab-title.md` with Status/Date, Context, Decision, Consequences. Superseding a decision = a new ADR that names the old one; old ADRs are never edited except to mark them superseded.

- [ADR-0001](0001-build-own-starter.md): Build our own starter instead of adopting or forking a template
- [ADR-0002](0002-single-tanstack-start-worker.md): One TanStack Start Worker on Workers Static Assets
- [ADR-0003](0003-neon-postgres-via-hyperdrive-drizzle.md): Neon PostgreSQL via Hyperdrive, with Drizzle (backup option B: superseded by ADR-0023; Neon plan: ADR-0026)
- [ADR-0004](0004-uncached-hyperdrive-binding.md): Read auth and permission data through an uncached Hyperdrive binding
- [ADR-0005](0005-better-auth-identity-app-owned-authorization.md): Better Auth for identity; authorization is application code
- [ADR-0006](0006-toolchain.md): Toolchain: pnpm, TypeScript 6, ESLint 9 + Prettier, Zod, Vitest 4, Playwright
- [ADR-0007](0007-defer-cloudflare-products.md): Defer Cloudflare products until a named trigger
- [ADR-0008](0008-agents-md-canonical.md): AGENTS.md and ADRs are the canonical agent context
- [ADR-0009](0009-billing-plans-entitlements-stripe-adapter.md): Billing: plans → entitlements, Stripe behind an adapter
- [ADR-0010](0010-path-based-tenancy.md): Address tenants by URL path (`/t/<slug>`), not subdomain
- [ADR-0011](0011-per-pr-preview-neon-branch.md): Each PR preview gets its own Neon branch and Hyperdrive config
- [ADR-0012](0012-claude-implements-codex-reviews.md): Claude Code implements, Codex reviews, in separate working trees
- [ADR-0013](0013-ci-credential-tiers.md): CI credential tiers: no secrets where PR code runs
- [ADR-0014](0014-first-production-launch-gates.md): First production launch gates (data gate, backups, WAF)
- [ADR-0015](0015-observability-baseline.md): Observability baseline: Cloudflare Workers Logs first, Sentry only for named gaps
- [ADR-0016](0016-transactional-email.md): Transactional email: Cloudflare Email Service behind an app mailer
- [ADR-0017](0017-production-account-and-custom-domain.md): Production Cloudflare account and custom domain
- [ADR-0018](0018-billing-platform.md): Billing platform: verified webhooks, organization-owned subscription state, default entitlements (its provider: superseded by ADR-0022)
- [ADR-0019](0019-ci-credentials-and-preview-slots.md): CI credentials by resource, and pre-provisioned preview slots
- [ADR-0020](0020-billing-product-policy.md): Billing product policy in one place, with reference defaults (tax, price lookup, portal, going live with Stripe: superseded by ADR-0022)
- [ADR-0021](0021-per-pr-preview-data-behind-a-trusted-boundary.md): Per-PR preview data behind a trusted workflow boundary
- [ADR-0022](0022-polar-merchant-of-record.md): Polar as billing provider and merchant of record; one Polar team customer per organization
- [ADR-0023](0023-off-provider-database-dumps-to-r2.md): Off-provider database dumps to Cloudflare R2 (ADR-0003 backup option B)
- [ADR-0024](0024-email-activation-send-email-binding.md): Activate transactional email: the `send_email` binding `EMAIL` (ADR-0016 step 3)
- [ADR-0025](0025-turnstile-bot-protection-on-auth.md): Bot protection on sign-up, sign-in and auth email: Cloudflare Turnstile through Better Auth's captcha plugin
- [ADR-0026](0026-neon-plan-capacity-and-upgrade-trigger.md): Neon plan for launch: Free's capacity limits and the upgrade trigger
- [ADR-0027](0027-polyglot-service-and-repository-boundaries.md): Polyglot services and repository boundaries
- [ADR-0028](0028-public-docs-site.md): Public product docs: a static Starlight site on its own assets-only Worker
- [ADR-0029](0029-releases-deploys-and-rollback.md): Releases, deploys and rollback: release PRs, a 0% release candidate, dispatch and rollback workflows
- [ADR-0030](0030-git-workflow.md): Git workflow: trunk-based, squash-merged Conventional PRs, specs in the PR
- [ADR-0031](0031-production-alerting-issues-to-slack.md): Production alerting: Workers Issues automations to a private Slack channel
- [ADR-0032](0032-lift-the-data-gate-allowlisted-pilot.md): Lift the data gate: an allowlisted pilot with real customer data on Polar's sandbox
