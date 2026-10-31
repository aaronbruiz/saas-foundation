# ADR-0015: Observability baseline: Cloudflare Workers Logs first, Sentry only for named gaps

Status: Accepted (owner decision 2026-09-28, Q8) · Date: 2026-09-28

Superseded in part by [ADR-0031](0031-production-alerting-issues-to-slack.md): the alerting requirement, both clauses (restated as an alert on each new issue and on an issue's return after an hour), and the "not configured here" note (automations to a private Slack channel).

## Context

First production needs a way to see and act on failures. The owner chose Cloudflare's built-in Workers Observability as the baseline and ruled out adding a vendor just because Phase 5 says "error tracking". Sentry is the prepared next step for gaps that Cloudflare demonstrably doesn't cover.

What Cloudflare gives us (Cloudflare docs, checked 2026-09-28):

- **Workers Logs:** `console.*` output plus one invocation log per request (status, duration, outcome), queryable in the dashboard, and live with `wrangler tail`.
  - Retention: **7 days on Workers Paid** (3 on Free). Sampling via `head_sampling_rate`.
  - Pricing above the included volume: [to confirm] (see Cloudflare's Workers Logs pricing).
- **Alerting:** Cloudflare Notifications has a Workers observability alert type (`workers_observability_alert`, delivered by email or webhook). Which conditions it can express, and on which plan, is [to confirm].
- **Source-mapped stack traces:** we upload source maps (`upload_source_maps: true`), which Cloudflare uses for Worker stack traces.
- **Error grouping:** Cloudflare's observability API exposes grouping fields (`errorTemplate`, `fingerprint`). Whether the dashboard gives issue-style grouping (first/last seen, regressions) is [to confirm].
- **Probably not provided (verify before adopting Sentry):**
  - browser (client-side) errors: the Worker never sees them;
  - release/deploy correlation beyond Worker version ids [to confirm];
  - retention beyond 7 days.

A gap found while doing this: TanStack Start turns errors thrown in server functions into error responses. Those failures never appear as Worker **exceptions**; the invocation just ends normally. Without our own logging they were effectively invisible. `/api/health` also swallowed the database error it reported as "down".

## Decision

- **Enabled:**
  - `apps/web/wrangler.jsonc`: `observability.enabled`, `logs.enabled`, `logs.invocation_logs`, `head_sampling_rate: 1`. Every request is logged; lower the rate only if volume or cost requires it.
  - Previews inherit the same settings.
- **Log contract** (`apps/web/src/server/log.ts`):
  - one JSON object per line: `level`, `event` (stable dot-separated name), optional fields, and `error: { name, message, code }`;
  - **no secrets or PII**: never request bodies, headers, cookies, tokens, connection strings or user data as fields;
  - error messages are truncated (300 chars) and redacted defensively: emails, URL credentials, auth schemes, `key=value` secrets, query strings, long opaque tokens;
  - redaction is best effort (it can't recognize a person's name), so new logs should rely on `event` and `code` rather than message text;
  - driver details (e.g. Postgres `detail`, which can contain row values) are never copied.
- **Request URLs:** `redact_query_string: true` strips query strings from logged URLs. **Path segments are logged**, so capability tokens must never travel in a path. Two cases:
  - Better Auth's default password-reset link puts the token in the path. The email work (Q7) must use a query-string link instead.
  - Invitation ids are in the path (`/invite/<id>`). They're only usable by the invited, signed-in email, so this is accepted.
- **What gets logged:**
  - `server_fn.unhandled`: any server-function error that isn't an expected client error. `HttpError`s and library errors with a 4xx `statusCode` (e.g. Better Auth `APIError`) aren't logged; everything else is.
  - `health.db_down`: the reason behind a failing health check.
  - `better_auth`: Better Auth's own warnings and errors, level and redacted message only (its extra arguments can hold request data).
- **Correlation id:** Cloudflare's per-request `cf-ray` header, logged as `rayId`. It also appears on Cloudflare error pages and in Cloudflare's request logs, so a user-reported ray id leads straight to our log line. Console lines from one request are also grouped with that request's invocation log in Workers Logs.
- **Where to inspect:** `docs/runbooks/README.md`, section "Observability".
- **Alerting requirement.** Before real customer data (the ADR-0014 data gate), the owner must be notified, by email or webhook, within 15 minutes of:
  - any `server_fn.unhandled` or `health.db_down` event; or
  - a 5xx rate above 1% of requests over 5 minutes.

  If Cloudflare's Workers observability alerts can express this on our plan, configure them and record it here. If not, that unmet requirement is the trigger for Sentry.

  - _Checked 2026-09-30 (Cloudflare docs "Workers Issues" and "Set up an automation"; owner in the dashboard):_
    - **Workers Issues** (open beta, free during the beta, all Workers plans) is enabled in `wrangler.jsonc` (`observability.issues`). It records an occurrence for uncaught exceptions, failed invocations, `5xx` responses and error-level console logs, so `logError`'s `server_fn.unhandled` and `health.db_down` are covered, and groups them into issues.
    - Alerting from it is an **automation** (dashboard: the Worker's Issues → Automations): trigger "occurrence threshold" (minimum 1; runs once per issue when crossed) or "recurrence after inactivity" (1 hour to 365 days); destinations: generic webhook (with a secret or mTLS), chat, incident management, coding agents. **No email destination** is documented.
    - Gaps against this requirement: no email; a threshold automation doesn't re-alert while a known issue keeps occurring; no rate rule (5xx share over 5 minutes); delivery latency isn't documented. Cloudflare's webhook reference lists a `workers_observability_alert` notification type, but its setup isn't documented, and creating it in the dashboard failed for the owner (not retried).
    - **Not configured here** (owner decision): no automation and no destination. The deploying project chooses the destination, adds the automations (threshold 1 and recurrence after 1 hour), tests one controlled failure end to end within 15 minutes, and decides the rate rule (the Cloudflare notification, if it works by then, or Sentry). Issue data carries error messages and stack traces: vet the destination's access and data handling first.
    - **Until then this requirement is unmet, and the ADR-0014 data gate stays closed on it.**

- **Sentry (next step, not adopted).** Adopt it with a new ADR (DSN as a Worker secret, PII scrubbing on, source maps uploaded from CI) only when one of these is needed **and** Cloudflare has been checked and doesn't cover it:
  - issue grouping;
  - alerting;
  - browser/client error capture and correlation with server errors;
  - release/deployment correlation.

## Consequences

- Production failures are visible for 7 days and searchable by `event` and `rayId`.
- Logging a new failure mode means choosing an `event` name, not writing free text; new fields must be non-sensitive.
- Client-side errors stay invisible until the Sentry trigger fires.

## Notes

- **Server-function error envelope (2026-10-29, research R01, local probe on TanStack Start 1.169):**
  - An error thrown inside a server-function handler reaches the browser as HTTP 200 with a serialized body. Only the error's `message` crosses; `status`, `name` and `stack` don't. Expected errors' statuses are therefore an application contract (`HttpError.status`, tested at the service level), not an HTTP one.
  - An unexpected error thrown through `serve()` (every server function except `getTurnstileConfigFn`) is logged once (`server_fn.unhandled`, redacted) and then reaches the client as a generic message (`forClient` in `server/log.ts`), since a library message can carry internal detail. Expected errors (`HttpError`, Better Auth 4xx) keep their messages.
- **One exception for a linkable identifier (2026-10-31, ADR-0044, owner decision):** `account.deleted` carries `subject_sha256`, the SHA-256 of the user id, as best-effort recovery evidence for a restore; never a complete ledger. No email, name, credentials or tokens. Nothing else may use it.
