# ADR-0025: Bot protection on sign-up, sign-in and auth email: Cloudflare Turnstile through Better Auth's captcha plugin

Status: Proposed · Date: 2026-10-01

Closes the bot-protection item in [ADR-0005](0005-better-auth-identity-app-owned-authorization.md)'s "Accepted limits" and the Turnstile decision launch milestone D needs (runbook "First production deploy"). Turnstile is a Cloudflare product, so it needs this ADR (AGENTS.md invariant 14); it adds no binding.

## Context

- ADR-0005's login rate limit counts per IP (Better Auth, 5 POSTs per 60 s on sign-in and sign-up, stored in Postgres) plus a WAF rule at the edge. Distributed credential stuffing and sign-up or email abuse from many IPs pass both. ADR-0005 deferred bot protection to "abuse observed or before public launch".
- **Trigger:** public sign-up (launch milestone D, `SIGNUP_MODE=open`) needs a bot-protection decision first. Building it now, while milestone C waits on dates and the owner, means D doesn't wait on it. Until D, sign-up stays allowlisted (ADR-0014) and Turnstile also covers sign-in and password resets for the allowlisted users.
- Unauthenticated Better Auth endpoints that try a password, create an account or send email: `/sign-in/email`, `/sign-up/email`, `/request-password-reset` and `/send-verification-email`. The UI uses the first three; sign-in resends the verification link (ADR-0016), so the UI never calls the fourth, but it's reachable over HTTP. `/verify-email` and `/reset-password` need a token from an email; everything else needs a session.
- Better Auth 1.7.6 ships a `captcha` plugin (checked in the installed source, 2026-10-01):
  - provider `cloudflare-turnstile`; token in the `x-captcha-response` request header; `endpoints` replaces its default list (`/sign-up/email`, `/sign-in/email`, `/request-password-reset`);
  - missing token → 400 `MISSING_RESPONSE`; siteverify says no → 403 `VERIFICATION_FAILED`; siteverify unreachable, erroring or slower than 10 s → 500 (fail closed);
  - `allowedHostnames` rejects a token issued for another hostname;
  - it runs in Better Auth's router `onRequest`, **after** the rate limiter, so rate limiting still applies first and also caps siteverify calls; it only sees requests through the HTTP handler (`/api/auth/*`), which is the only way sign-in and sign-up are done (ADR-0005).
- Cloudflare's Turnstile test keys (docs "Testing", checked 2026-10-01): site key `1x00000000000000000000AA` always passes and produces the dummy token `XXXX.DUMMY.TOKEN.XXXX`; secret `1x0000000000000000000000000000000AA` always passes, `2x…AA` always fails, `3x…AA` answers "already spent". Production secrets reject the dummy token. Observed on 2026-10-01 with `curl`: the passing test secret answers `success: true`, `hostname: "example.com"`, `metadata.result_with_testing_key: true`.
- The preview gate refuses `vars` in the Worker config (ADR-0021, ADR-0024); previews set theirs with `--var` from `main`'s `scripts/preview/lib.sh`.

## Decision

- **Turnstile through Better Auth's `captcha` plugin** on `/sign-up/email`, `/sign-in/email`, `/request-password-reset` and `/send-verification-email` (`BOT_PROTECTED_PATHS` in `packages/auth`). Other endpoints aren't checked (they need an emailed token or a session).
- **Keys** come only from Worker `env`: `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY`. The site key is public, but it's a Worker secret in production too: config `vars` would break the preview gate, and a build-time value would tie the build to one environment. The auth pages read it per request through a server function.
  - Production: a widget the owner creates in the Cloudflare dashboard (Managed mode), hostname `app.aaronlabr.dev` only.
  - Local dev, E2E, Vitest and previews: Cloudflare's always-pass **test keys** (public values: `.dev.vars`, CI's E2E step, `vitest.config.ts`, `lib.sh --var`). Test keys work on any hostname, so the widget lists no other hostname.
- **No "off"**, and a misconfiguration fails closed (`botProtectionFor` in `apps/web/src/server/auth.ts`):
  - a missing key → the four endpoints answer 503 `CAPTCHA_UNAVAILABLE` and the forms show the bot check as unavailable; logged `auth.turnstile_misconfigured` (`reason: missing_key`);
  - a test key (either one) on any URL but `http://localhost`/`127.0.0.1` or a `https://*.workers.dev` preview → the same 503, `reason: test_key`;
  - test keys accepted on localhost or a preview are bound to that URL's host: a protected request arriving at any other host (e.g. a production Worker misconfigured with a workers.dev `BETTER_AUTH_URL`, reached on its custom domain) gets the same 503, logged `auth.turnstile_wrong_host`;
  - with real keys, the token must report the app's own hostname (`allowedHostnames` = the host of `BETTER_AUTH_URL`), which also rejects any test-key token (`example.com`).
  - `pnpm run deploy` refuses when the production Worker lacks either secret name (`scripts/check-turnstile.mjs --deployed`; values can't be read back, so the app's check above covers them).
- **Siteverify down:** the plugin answers 500 and nothing is created (fail closed). Logged at error level as `auth.captcha_unavailable` (the plugin's own message is whatever was thrown, so `packages/auth` maps it to that stable name); Workers Issues groups error-level logs (ADR-0015). A rejected token is Better Auth's warn-level log (`better_auth`).
- **Client:** a small component (`apps/web/src/lib/turnstile.tsx`, no new dependency) loads `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` only on `/login`, `/signup` and `/forgot-password`, renders the widget explicitly, keeps the submit button disabled until the page is hydrated **and** a token exists, clears the token on expiry or error, and resets the widget after every submit (tokens are single-use). The token travels only in the `x-captcha-response` header; forms keep `method="post"` (invariant 8). There's no Content-Security-Policy today; one added later must allow `challenges.cloudflare.com` in `script-src` and `frame-src`.
- **Tests:** never exempted (ADR-0005). Every request in Vitest goes through the real plugin with the dummy token and the always-pass test secret; only the siteverify HTTP call is answered locally, the way Cloudflare answers it for test secrets (`apps/web/test/turnstile-fake.ts`), so tests need no network. `test/turnstile.test.ts` covers each protected path (missing → 400, rejected → 403, valid → the endpoint), the request siteverify gets (secret, token, client IP), no account on a rejected or spent token, a foreign hostname, siteverify down (500, nothing created, logged), rate limiting before siteverify, untouched endpoints, the `unavailable` mode, and `botProtectionFor`. E2E uses the always-pass site key with the real widget.
- **Previews** get only the test keys (no production secret, nothing to isolate).

## Alternatives

- **WAF managed challenge on the auth paths:** a challenge page can't be answered by the app's `fetch` POSTs (it would break the forms), and rule options are limited on the Free zone plan (ADR-0014). The existing WAF rate rule stays as defense in depth.
- **Another captcha provider through the same plugin** (reCAPTCHA, hCaptcha, CaptchaFox): another vendor and subprocessor in the privacy list, while Turnstile is free, already within Cloudflare, and has documented test keys.
- **Our own siteverify middleware:** the plugin already verifies, fails closed, times out and runs after the rate limiter; owning that code buys nothing.
- **Turnstile on sign-up only:** leaves credential stuffing on sign-in, the gap ADR-0005 named.
- **Skip the check where the secret is unset (dev, tests):** a code path that skips verification in production when a secret is missing; the 503 mode instead makes a missing key visible and safe.

## Consequences

- Sign-in, sign-up and password-reset requests need the visitor's browser to pass Turnstile; scripts and API clients can't use these endpoints without a token. A blocked or failing widget (e.g. the script blocked by an extension) means the form can't be submitted; the page says so.
- Production can't sign anyone in until both secrets are set, so the owner sets them **before** deploying this release (runbook "Turnstile").
- A protected request that carries a token and passes the rate limit costs one siteverify call; requests without a token, rate-limited ones and the 503 mode make none.
- Turnstile becomes a subprocessor for the legal pages milestone D needs.
- Local dev needs the two test keys in `apps/web/.dev.vars` (see `.dev.vars.example`); without them sign-in answers 503 locally too.
- Order of work: this PR (code, tests, docs) → owner creates the widget, sets the secrets, deploys, browser check (runbook "Turnstile") → status Accepted with the date.
