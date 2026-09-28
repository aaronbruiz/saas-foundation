# Architecture Decision Records

One file per decision: `NNNN-kebab-title.md` with Status/Date, Context, Decision, Consequences. Superseding a decision = a new ADR that names the old one; old ADRs are never edited except to mark them superseded.

- [ADR-0001](0001-build-own-starter.md): Build our own starter instead of adopting or forking a template
- [ADR-0002](0002-single-tanstack-start-worker.md): One TanStack Start Worker on Workers Static Assets
- [ADR-0003](0003-neon-postgres-via-hyperdrive-drizzle.md): Neon PostgreSQL via Hyperdrive, with Drizzle
- [ADR-0004](0004-uncached-hyperdrive-binding.md): Read auth and permission data through an uncached Hyperdrive binding
- [ADR-0005](0005-better-auth-identity-app-owned-authorization.md): Better Auth for identity; authorization is application code
- [ADR-0006](0006-toolchain.md): Toolchain: pnpm, TypeScript 6, ESLint 9 + Prettier, Zod, Vitest 4, Playwright
- [ADR-0007](0007-defer-cloudflare-products.md): Defer Cloudflare products until a named trigger
- [ADR-0008](0008-agents-md-canonical.md): AGENTS.md and ADRs are the canonical agent context
- [ADR-0009](0009-billing-plans-entitlements-stripe-adapter.md): Billing: plans → entitlements, Stripe behind an adapter
- [ADR-0010](0010-path-based-tenancy.md): Address tenants by URL path (`/t/<slug>`), not subdomain
- [ADR-0011](0011-per-pr-preview-neon-branch.md): Each PR preview gets its own Neon branch and Hyperdrive config
- [ADR-0012](0012-claude-implements-codex-reviews.md): Claude Code implements, Codex reviews, in separate working trees
- [ADR-0013](0013-ci-credential-tiers.md): CI credential tiers: no secrets where PR code runs (proposed)
- [ADR-0014](0014-first-production-launch-gates.md): First production launch gates (data gate, backups, WAF)
- [ADR-0015](0015-observability-baseline.md): Observability baseline: Cloudflare Workers Logs first, Sentry only for named gaps
