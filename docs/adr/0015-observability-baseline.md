# ADR-0015: Observability baseline: Cloudflare Workers Logs first, Sentry only for named gaps

Status: Accepted (owner decision 2026-09-28, Q8) · Date: 2026-09-28

## Context

First production needs a way to see and act on failures. The owner chose Cloudflare's built-in Workers Observability as the baseline and ruled out adding a vendor just because Phase 5 says "error tracking". Sentry is the prepared next step for gaps that Cloudflare demonstrably doesn't cover.

What Cloudflare gives us (Cloudflare docs, checked 2026-09-28):

- **Workers Logs:** `console.*` output plus one invocation log per request (status, duration, outcome), queryable in the dashboard, and live with `wrangler tail`.
  - Retention: **7 days on Workers Paid** (3 on Free). Sampling via `head_sampling_rate`.
  - Pricing above the included volume: [to confirm] (see Cloudflare's Workers Logs pricing).
- **Alerting:** Cloudflare Notifications has a Workers observability alert type (`workers_observability_alert`, delivered by email or webhook). Which conditions it can express, and on which plan, is [to confirm].
- **Not provided, as far as we know:**
  - grouping and deduplication of errors into issues, with first/last seen and regressions;
  - browser (client-side) errors;
  - source-mapped stack traces per release, and linking errors to deploys;
  - retention beyond 7 days.

A gap found while doing this: TanStack Start turns errors thrown in server functions into error responses. Those failures never appear as Worker **exceptions**; the invocation just ends normally. Without our own logging they were effectively invisible. `/api/health` also swallowed the database error it reported as "down".

## Decision

- **Enabled:**
  - `apps/web/wrangler.jsonc`: `observability.enabled`, `logs.enabled`, `logs.invocation_logs`, `head_sampling_rate: 1`. Every request is logged; lower the rate only if volume or cost requires it.
  - Previews inherit the same settings.
- **Log contract** (`apps/web/src/server/log.ts`):
  - one JSON object per line: `level`, `event` (stable dot-separated name), optional fields, and `error: { name, message, code }`;
  - **no secrets or PII**: never request bodies, headers, cookies, tokens, connection strings or user data as fields;
  - error messages are redacted defensively (emails, credentials in URLs);
  - driver details (e.g. Postgres `detail`, which can contain row values) are never copied.
- **What gets logged:**
  - `server_fn.unhandled`: any server-function error that isn't an expected client error. `HttpError`s and library 4xx errors (e.g. Better Auth `APIError`) aren't logged.
  - `health.db_down`: the reason behind a failing health check.
  - `better_auth`: Better Auth's own warnings and errors, level and redacted message only (its extra arguments can hold request data).
- **Correlation id:** Cloudflare's per-request `cf-ray` header, logged as `rayId`. It also appears on Cloudflare error pages and in Cloudflare's request logs, so a user-reported ray id leads straight to our log line. Console lines from one request are also grouped with that request's invocation log in Workers Logs.
- **Where to inspect:** `docs/runbooks/README.md`, section "Observability".
- **Alerting requirement.** Before real customer data (the ADR-0014 data gate), the owner must be notified, by email or webhook, within 15 minutes of:
  - any `server_fn.unhandled` or `health.db_down` event; or
  - a 5xx rate above 1% of requests over 5 minutes.

  If Cloudflare's Workers observability alerts can express this on our plan, configure them and record it here. If not, that unmet requirement is the trigger for Sentry.

- **Sentry (next step, not adopted).** Adopt it with a new ADR (DSN as a Worker secret, PII scrubbing on, source maps uploaded from CI) when one of these is needed:
  - automatic issue grouping;
  - alerting that Cloudflare can't express;
  - browser/client error capture and correlation with server errors;
  - release/deployment correlation.

## Consequences

- Production failures are visible for 7 days and searchable by `event` and `rayId`.
- Logging a new failure mode means choosing an `event` name, not writing free text; new fields must be non-sensitive.
- Client-side errors stay invisible until the Sentry trigger fires.
