# Identity and bot protection: Better Auth and Turnstile

## Responsibility

**Better Auth** (in-process, no external service) owns identity: users, passwords, sessions, email verification, password reset, organizations, memberships and invitations. **Authorization is ours**: which tenant a request may act in and what a role may do are decided by `getTenantContext` and the capability matrix, not by Better Auth ([ADR-0005](../adr/0005-better-auth-identity-app-owned-authorization.md); [domain model](../architecture/domain-model.md#how-a-request-is-authorized)).

**Cloudflare Turnstile** checks that sign-up, sign-in, password-reset requests and verification-email requests come from a person, through Better Auth's captcha plugin ([ADR-0025](../adr/0025-turnstile-bot-protection-on-auth.md)). Sign-ups are also gated by an allowlist until public sign-up is opened ([ADR-0014](../adr/0014-first-production-launch-gates.md)).

## Owning files

| File                                                                                                                                      | Role                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/auth/src/auth.ts`](../../packages/auth/src/auth.ts)                                                                            | Better Auth's configuration: rate limits, captcha on `BOT_PROTECTED_PATHS`, organization plugin and its billing hooks, seat limits |
| [`apps/app/src/server/auth.ts`](../../apps/app/src/server/auth.ts) (`authFor`)                                                            | per-request instance: sign-up gate, verification setting, Turnstile keys, the owner-change billing hooks, invitation links         |
| [`apps/app/src/routes/api/auth/$.ts`](../../apps/app/src/routes/api/auth/$.ts)                                                            | the HTTP handler at `/api/auth/*`: the only way to sign in or up (rate limited)                                                    |
| [`apps/app/src/server/context.ts`](../../apps/app/src/server/context.ts)                                                                  | session → slug → organization → membership                                                                                         |
| [`apps/app/src/server/turnstile.ts`](../../apps/app/src/server/turnstile.ts), [`lib/turnstile.tsx`](../../apps/app/src/lib/turnstile.tsx) | the site key and actions for the auth pages; the widget                                                                            |
| `packages/db/src/schema/auth.ts`                                                                                                          | generated from the config (`pnpm auth:generate`); never edited by hand                                                             |

Sign-in and sign-up go through the HTTP handler, never `auth.api.*` server calls, which would skip the rate limit (Code Review Rules).

## Configuration

| Name                                         | Missing or unset means                                                                                                                                     | Source of the rule                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `BETTER_AUTH_SECRET`                         | the app can't sign sessions; required everywhere                                                                                                           | Worker secret; `.dev.vars` locally                 |
| `BETTER_AUTH_URL`                            | the app's origin; links in emails and redirects are built from it; locally `http://localhost:3000`                                                         | `signUpPolicy`, `mailerFor`, Turnstile host checks |
| `SIGNUP_MODE`, `SIGNUP_ALLOWLIST`            | unset mode = **closed**: only the exact allowlisted addresses may sign up; `open` admits anyone (local, tests, previews)                                   | `signUpPolicy` in `server/auth.ts`, ADR-0014       |
| `EMAIL_VERIFICATION`                         | verification is required; `off` is honoured only on a workers.dev preview, refused and logged elsewhere                                                    | `emailVerificationRequired`, ADR-0016              |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | either missing: the protected endpoints answer **503** (fail closed) and the forms stay disabled; Cloudflare's test keys only on localhost and workers.dev | `botProtectionFor`, ADR-0025                       |

Rate limits live in `packages/auth/src/auth.ts` (`rateLimit`, counted in Postgres per client IP from `cf-connecting-ip`); changing them updates ADR-0005 (Code Review Rules).

## Environments

| Environment | Sign-up   | Verification                                     | Turnstile                                                               |
| ----------- | --------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Local       | open      | required; the link is printed to the dev console | always-pass test keys from `.dev.vars.example`                          |
| Preview     | open      | off (previews send no email)                     | test keys, bound to the preview's host                                  |
| Production  | allowlist | required                                         | real keys; the token must name the app's hostname and the form's action |

## Data exchanged

Better Auth stores email, name, a password hash, sessions and OAuth fields in our database; nothing leaves the Worker for identity. Turnstile receives the widget token, the client IP and the secret key from the server (`siteverify`), and the browser loads its script and iframe from `https://challenges.cloudflare.com`, the CSP's only third-party origin ([ADR-0045](../adr/0045-app-security-headers.md)). The token travels only in the `x-captcha-response` header, never in a URL.

## Failures

| Situation                                                                 | What the person sees or the caller gets                                                               | Log event                                             |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| No session on a tenant request                                            | 401                                                                                                   | none                                                  |
| Unknown tenant or not a member                                            | 404, the same page as any missing resource                                                            | none                                                  |
| Too many sign-ins or sign-ups from one IP                                 | 429                                                                                                   | none                                                  |
| Turnstile misconfigured (missing key, test key outside localhost/preview) | 503 "temporarily unavailable" on the protected endpoints; forms disabled                              | `auth.turnstile_misconfigured` (with a `reason`)      |
| Turnstile token refused, spent or for another host                        | the sign-up or sign-in is refused; no account is created                                              | none (siteverify outages: runbook "Turnstile" step 5) |
| Test keys reached on another host than `BETTER_AUTH_URL`'s                | 503                                                                                                   | `auth.turnstile_wrong_host`                           |
| Turnstile's siteverify unreachable                                        | 500                                                                                                   | `auth.captcha_unavailable`                            |
| Sign-up address not allowlisted                                           | refused; when verification is required, answered like any sign-up, so it doesn't reveal the allowlist | none                                                  |
| Unverified address signs in                                               | refused, and a new link is sent                                                                       | none                                                  |
| `EMAIL_VERIFICATION=off` outside a preview                                | ignored: verification stays on                                                                        | `auth.email_verification_off_refused`                 |

## Retry safety

Sign-in and sign-up retries spend the rate limit. A password-reset request answers the same whether or not the account exists, and sends in the background, so its timing doesn't tell either. Invitation acceptance is safe to retry: a used invitation is a 404, and the member row exists once.

## Tests and operations

- Tests: [`turnstile.test.ts`](../../apps/app/test/turnstile.test.ts) (with the local siteverify fake [`turnstile-fake.ts`](../../apps/app/test/turnstile-fake.ts)), [`rate-limit.test.ts`](../../apps/app/test/rate-limit.test.ts), [`signup-gate.test.ts`](../../apps/app/test/signup-gate.test.ts), [`email.test.ts`](../../apps/app/test/email.test.ts) (verification and reset), [`tenancy.test.ts`](../../apps/app/test/tenancy.test.ts) and [`roles.test.ts`](../../apps/app/test/roles.test.ts) (context and capabilities). E2E sign-ins are budgeted by the rate limit ([`docs/testing.md`](../testing.md#testing-a-product-feature)).
- Runbooks: ["Turnstile"](../runbooks/README.md#turnstile-adr-0025) (keys, rotation, 503s), ["Email"](../runbooks/README.md#email-adr-0016-adr-0024) step 5 (verification rollout).
