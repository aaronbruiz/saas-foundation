# ADR-0017: Production Cloudflare account and custom domain

Status: Accepted (owner 2026-09-28) · Date: 2026-09-28

Superseded in part by [ADR-0019](0019-ci-credentials-and-preview-slots.md): who creates the production Hyperdrive config (created 2026-09-28).

Supersedes in part [ADR-0003](0003-neon-postgres-via-hyperdrive-drizzle.md) (the production Hyperdrive config id, which belonged to the previous account).

## Context

The owner moved the project to another Cloudflare account, one that holds a purchased domain as an active zone (Free zone plan). The new account had no Workers or Hyperdrive configs yet. The previous account held the production Hyperdrive config and the per-PR preview resources. Its CI token was replaced, so CI can no longer reach it. Nothing had ever been deployed to production.

Concrete identifiers live only where tooling needs them: `account_id` and `routes` in `apps/web/wrangler.jsonc`, and the `CLOUDFLARE_ACCOUNT_ID` CI variable. Docs refer to them generically.

## Decision

- **Account pinned:**
  - `apps/web/wrangler.jsonc` sets `account_id`; Wrangler gives it precedence over the environment;
  - CI's `CLOUDFLARE_ACCOUNT_ID` must equal it, and the preview scripts refuse to run otherwise;
  - the logged-in Wrangler session is this account.
- **Production hostname:** a subdomain of the production zone, served as a Workers Custom Domain (`routes[].custom_domain` in `wrangler.jsonc`). Cloudflare creates its DNS record and certificate on deploy.
  - The hostname can still change before the first deploy; `BETTER_AUTH_URL` must equal `https://<production hostname>`.
- **No production `workers.dev` URL** (`workers_dev: false`) **and no per-version preview URLs** (`preview_urls: false`). Both would serve production outside the zone's WAF rule (ADR-0014).
  - PR previews run on a separate Worker, `saas-foundation-preview` (ADR-0013). Only CI's build copy enables `preview_urls` for it.
  - Found: `wrangler preview` creates a missing parent Worker with `previews_enabled = preview_urls ?? workers_dev`. The first preview run in the new account therefore also left an empty `saas-foundation` Worker (no scripts, no routes, `workers.dev` and previews off). That's harmless; the first production deploy fills it.
- **Production Hyperdrive:**
  - a new config `saas-foundation-prod` in this account, caching disabled (ADR-0004), pointing at the same Neon production branch (`flat-cherry-23373668`, `main`, direct host);
  - **the owner creates it**, since it handles the production connection string;
  - until its id is in `wrangler.jsonc`, the binding holds an all-`f` sentinel and a production deploy fails closed.
- **Email sending domain** (ADR-0016): the production zone, once the owner confirms Workers Paid on this account.
- **The previous account** gets no more changes from this project. The owner cleans it up:
  - the old `saas-foundation-prod` Hyperdrive config and any `saas-pr-*` configs;
  - preview deployments;
  - the old API token.

## Consequences

- Workers-plan-dependent facts need re-confirming on this account: Email Sending needs Paid; the Hyperdrive config limit is 25 on Paid; placement support [to confirm]. _(2026-09-29: the owner verified Workers Paid on this account.)_
- Neon is unchanged (same projects, branches and backups).
