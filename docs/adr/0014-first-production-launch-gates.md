# ADR-0014: First production launch gates

Status: Accepted (owner decisions 2026-09-28) · Date: 2026-09-28

Supersedes in part [ADR-0003](0003-neon-postgres-via-hyperdrive-drizzle.md) (trigger for backup option B) and [ADR-0005](0005-better-auth-identity-app-owned-authorization.md) (the edge-layer WAF rule).

## Context

The Worker has never been deployed to production. The owner set the first-production sequence (`docs/runbooks/README.md`, "First production deploy"), corrected the WAF rule, and made off-provider backups a precondition for real customer data.

## Decision

**1. Data gate.** Until backup option B (off-provider dump, ADR-0003) is implemented **and** a restore from it has been tested, production holds only synthetic smoke-test accounts, never real customer data.

- This is enforced in code, not only by procedure: a production **sign-up allowlist** (server-side, before Better Auth creates the user) admits only the smoke-test addresses while the gate is closed.
- The allowlist must exist before the first deploy.
- Lifting the gate is an owner decision recorded in a new ADR.

**2. Backups.** Neon Free's 6 h restore window and the daily snapshot branches (option A) are development-grade conveniences, not the production backup strategy.

- Before every production migration, take a synchronous restore point: a `pre-migrate-*` branch created without compute right before migrating.

**3. Edge rate limiting (WAF).** Defense in depth. The application limiter (ADR-0005, 5 per 60 s per IP on sign-in/sign-up) stays the primary, deterministic control.

- **Blocked until the production custom domain (zone) exists:** WAF rules apply to requests on a zone, not to `*.workers.dev` or preview URLs.
- Rule for the Free zone plan:
  - Security → WAF → Rate limiting rules → rule `auth-login-burst` (Free allows one rate limiting rule).
  - Expression: `(http.request.uri.path in {"/api/auth/sign-in/email" "/api/auth/sign-up/email"})`. It matches on path only; Free rule expressions offer Path and Verified Bot.
  - Counting characteristic: IP. Counting period **10 s**, mitigation (block) period **10 s**: the only values Free offers.
  - Requests per period: **10**. This is our choice, not a plan limit. It sits above what the app allows, so the rule only absorbs bursts before they reach the Worker and Postgres.
- Method: `http.request.method` needs **Business**, so on Free any request to those paths counts. Accepted: the counter is per IP and the block lasts 10 s. On Business, add `and http.request.method eq "POST"`.
- Smoke-test it on its own after applying (runbook step 10).
- Plan limits source: Cloudflare WAF docs, "Rate limiting rules: availability by plan" (checked 2026-09-28).

## Consequences

- The first deploy needs the sign-up allowlist implemented (small, server-side) and the production domain.
- Real users wait for option B (R2 dumps, their own ADR under ADR-0007) and a tested restore.
