# ADR-0031: Production alerting: Workers Issues automations to a private Slack channel

Status: Accepted (owner 2026-10-13: destination Slack). Set up by the owner and tested end to end 2026-10-14 (section "Rollout", "Result"): the new-issue alert is verified and the rest of the setup owner-confirmed, so ADR-0015's alerting requirement, as restated in decision 3, is met. · Date: 2026-10-13

Meets [ADR-0015](0015-observability-baseline.md)'s alerting requirement, which milestone C (real customer data, [ADR-0014](0014-first-production-launch-gates.md)'s data gate) waits on. Sends issue data (error messages, stack traces) to a third party, Slack, so it's a new trust boundary.

## Context

ADR-0015 requires that the owner be notified, by email or webhook, within 15 minutes of:

- any `server_fn.unhandled` or `health.db_down` event;
- a 5xx rate above 1 % of requests over 5 minutes.

Cloudflare's options (Workers docs via Context7 `/llmstxt/developers_cloudflare_workers_llms-full_txt`, "Issues" and "Set up an automation"; checked 2026-10-13; unchanged from ADR-0015's 2026-09-30 check):

- **Workers Issues** (enabled: `observability.issues` in `apps/web/wrangler.jsonc`) records an occurrence for every uncaught exception, failed invocation, **`5xx` response** and **error-level log**, and groups occurrences of the same failure into one issue. `logError` writes `server_fn.unhandled` and `health.db_down` at error level, so both are recorded.
- **Automations** send an issue to a destination when a trigger fires:
  - **occurrence threshold**: runs once when an issue's count crosses the threshold (minimum 1), not for each later occurrence;
  - **recurrence after inactivity**: runs when an issue that was quiet for the configured period (1 hour to 365 days) occurs again.
- **Destinations:** a coding agent, a generic webhook (Cloudflare Notifications' webhook payload), a chat service, or an incident-management tool. **No email.**
- **Not provided:** a rate rule (5xx share over a window), repeated alerts while one issue keeps occurring, a documented delivery latency.

Other options considered (owner, 2026-10-13):

- **Discord**: the same mechanism with a different chat service. No reason to prefer it.
- **An incident-management tool** (PagerDuty, Opsgenie): escalation and phone or SMS, but another vendor account for one owner.
- **Sentry**: email, rate rules and browser errors, but a new vendor, an SDK in the Worker and a DSN secret. It stays ADR-0015's next step, adopted only if this setup fails its test or a named gap needs it.
- **An uptime monitor polling `/api/health`**: `/api/health` queries the database. A check every few minutes keeps Neon awake around the clock (≈ 186 CU-hours a month at 0.25 CU), over Free's 100 ([ADR-0026](0026-neon-plan-capacity-and-upgrade-trigger.md)). Not on Free.

## Decision

1. **Destination: a private Slack channel** in the owner's workspace (e.g. `#saas-foundation-alerts`), with only the owner as a member. It's added in the Worker's Issues → Automations destination menu as a chat destination, or as a generic webhook pointing at a Slack incoming-webhook URL if Slack isn't offered there. The URL is a credential: it lives only in Cloudflare's destination settings, never in the repo, a Worker secret or CI.
2. **Automations on the production Worker `saas-foundation`**, both to that destination:
   - occurrence threshold **1** (every new issue alerts once);
   - recurrence after inactivity **1 hour** (an issue that returns after an hour's quiet alerts again).

   The preview and docs Workers get none: previews are short-lived and fail on purpose in tests.

3. **ADR-0015's requirement, restated** (supersedes both of its clauses, "any `server_fn.unhandled` or `health.db_down` event" and the 5xx rate rule). The owner is notified within 15 minutes of:
   - the **first occurrence of each new issue**: any uncaught exception, failed invocation, `5xx` response or error-level log, `server_fn.unhandled` and `health.db_down` included;
   - an issue's **return after at least 1 hour without occurrences**.

   What's lost compared with ADR-0015: **later occurrences of an issue already alerted on don't alert** (ADR-0015 asked for every event), and there's no rate rule. For the first failure of a kind this is stricter than "5xx above 1 % over 5 minutes", since one `5xx` is enough. The owner treats an alerted issue as ongoing until it's resolved in the Issues page, where its occurrence count shows whether it continues. A per-event or rate rule becomes a Sentry trigger if this proves too weak.

4. **Data sent to Slack**: an issue's summary and diagnostic context. Its exact fields aren't documented beyond Cloudflare Notifications' webhook payload, so the end-to-end test records them (Rollout step 3).
   - **What our code controls:** our own log lines follow ADR-0015's log contract (no secrets or PII, best-effort redaction), and query strings are stripped from logged URLs (`redact_query_string`).
   - **What it doesn't:** Issues captures uncaught exceptions and failed invocations **without our logger**, so their messages and stack traces are the framework's or library's, unredacted. Its diagnostic context may also carry request metadata or log lines. A private channel controls who sees them; it doesn't scrub anything.
   - **Residual risk, accepted** for a private channel with only the owner as a member: an unredacted exception message (for example one quoting a value) could reach Slack. If the test alert shows request headers, cookies, tokens, emails or bodies, the destination isn't acceptable as is: stop and revisit (a webhook to an endpoint we control that forwards a reduced summary, or Sentry with scrubbing). Slack keeps messages under the workspace's retention settings.
   - Alert content isn't copied to other channels or tickets (runbook "Observability").
5. **Latency target: 15 minutes**, checked by the end-to-end test below. Cloudflare doesn't document a latency, so the test is the evidence.
6. **The Neon usage check stays manual** (ADR-0026, every Monday): Issues doesn't see Neon's usage.

## Rollout

Owner, in the Cloudflare dashboard and Slack; then Claude records the result here and in the runbook.

1. Create the private channel and its incoming webhook (or Cloudflare's Slack connection).
2. Workers & Pages → `saas-foundation` → Issues → Automations: add the destination and the two automations above, enabled.
3. **End-to-end test, one controlled failure**: a same-origin `POST` to an unknown server-function id returns `500` and logs an error, without touching the database or needing a session (verified on `pnpm dev`, 2026-10-13: `Invalid server function ID`). In production:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H 'origin: https://app.aaronlabr.dev' -H 'content-type: application/json' -d '{}' \
     https://app.aaronlabr.dev/_serverFn/alert-test-$(date -u +%Y%m%d%H%M)
   ```

   Pass: `500`, an issue in the Issues page, and a Slack message **within 15 minutes** of the request. Record: the request time (UTC), the status, the issue, the Slack message time, and **which fields the Slack message carries** (decision 4: none of headers, cookies, tokens, emails or bodies). If production returns anything but `5xx`, pick another controlled failure before recording anything. Then resolve the test issue.

4. Fail (no message within 15 minutes, no destination works, or the message carries data decision 4 excludes): the requirement stays unmet, and Sentry's ADR becomes the next step (ADR-0015).

### Result (2026-10-14)

- **Setup, owner-reported (2026-10-14, "steps 1–3 done"):** the Slack incoming webhook checked with a test message; a Cloudflare Notifications webhook destination; on `saas-foundation` → Issues → Automations, occurrence threshold 1 and recurrence after 1 hour, both to that destination. The destination's name, `slack-saas-foundation-alerts`, is shown in the alert.
- **Owner-confirmed (2026-10-14, after the test):** the channel is private with only the owner as a member; the Slack app holds only the `incoming-webhook` scope and no bot token; the recurrence automation (1 hour) is enabled and points at `slack-saas-foundation-alerts`. The test exercised only the threshold automation; recurrence is configured, not yet exercised.
- **Test (Claude, owner-requested):** the request above at **04:38:11Z** returned **`500`** (`{"status":500,"unhandled":true,"message":"HTTPError"}`, ray `a4a3e4a72904e105`). The production build behaves like `pnpm dev`; its message differs ("Server function info not found" instead of "Invalid server function ID").
- **Alert:** Slack message at **04:38Z** (Slack shows minutes; 23:38 in the owner's time zone), so **under 1–2 minutes** against the 15-minute target. Alert type `workers_observability_real_time_issue`.
- **Fields in the message:** the issue title (error message, truncated, including the requested id from the path, and the top stack frame: `HTTPError · Server function info not found for ale… · at getServerFnById (assets/…server-fn-resolver<hash>.js)`), the Worker name, issue ID, type (`Log`), status (`Active`), occurrence count and alert type. **No headers, cookies, tokens, emails or bodies** (decision 4): pass. Request paths can appear in the title; ADR-0015 already keeps tokens out of paths.
- Owner: resolve the test issue (`bf399578-d10c-4db4-8846-0eefc02d0a00`) in the Issues page.

## Consequences

- The test passed (2026-10-14). ADR-0015's alerting requirement, as restated in decision 3, is met (setup owner-confirmed; recurrence configured, not yet exercised). Milestone C still needs smoke-account removal and the ADR that lifts the data gate.
- A failure the Worker turns into a non-5xx response without an error log (for example an expected 4xx) doesn't alert. That's intended.
- Anyone could cause such a `500` from outside: unknown server-function ids were answered with `500`, not `404`. Grouping limits the noise to one alert per new issue, plus one per hour of recurrence. **Follow-up done (2026-10-14):** a global request middleware (`apps/app/src/start.ts`) answers an unknown or not client-callable server-function id with a plain `404`, logging nothing. An empty id (`POST /_serverFn/`) still returns a logged `500`, because TanStack Start throws it before request middleware runs. To repeat Rollout step 3, use that path instead of `/_serverFn/alert-test-…`.
- ADR-0015 gets a "Superseded in part by ADR-0031" line for its alerting requirement (both clauses, restated in decision 3) and the "not configured here" note. Its log contract and Sentry triggers stand.
