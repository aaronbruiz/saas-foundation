# Authentication pages

**Purpose:** sign in, create an account, request and complete a password reset. **Frame:** `AuthLayout` (Rule: AGENTS.md "UI") — a title, an optional description and the form, in a narrow column that goes flat at 320 px so Turnstile's 300 px widget fits ([layout](../foundations/layout.md#why-the-auth-frame-is-so-narrow-at-320-px)).

**Routes:** [`login.tsx`](../../../apps/app/src/routes/login.tsx), [`signup.tsx`](../../../apps/app/src/routes/signup.tsx), [`forgot-password.tsx`](../../../apps/app/src/routes/forgot-password.tsx), [`reset-password.tsx`](../../../apps/app/src/routes/reset-password.tsx).

## Composition

1. `AuthLayout` with an `h1` title.
2. A `method="post"` form: `Field`s with labels and the right `autoComplete` and `type`.
3. The Turnstile widget on the protected forms (sign-in, sign-up, forgot password; [`lib/turnstile.tsx`](../../../apps/app/src/lib/turnstile.tsx)).
4. The submit, disabled until hydrated, while busy, and until Turnstile has a token.
5. Links to the other auth pages on their own lines (`authStandaloneLink`, 24 px).

## States

| State                                         | Current behaviour                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before hydration or without a Turnstile token | submit disabled                                                                                                                                                |
| Bot protection unavailable (no key)           | the widget can't render and the forms stay disabled; the server answers 503 if called ([identity](../../integrations/identity-and-bot-protection.md#failures)) |
| Submitted, waiting                            | submit disabled (`busy`)                                                                                                                                       |
| Sign-up done                                  | the form is replaced by a `role="status"` message to open the verification link                                                                                |
| Reset requested                               | a `role="status"` message that reads the same whether or not the account exists                                                                                |
| Unverified sign-in                            | refused, with a new link sent                                                                                                                                  |
| Wrong credentials, rate limited               | a form-level alert                                                                                                                                             |
| Signed in                                     | redirected to the `redirect` search parameter, sanitized ([`lib/safe-redirect.ts`](../../../apps/app/src/lib/safe-redirect.ts))                                |

## Rules this page keeps

- Fields never reach a URL: post, disabled until hydrated (invariant 8).
- Sign-in and sign-up go through the `/api/auth/*` handler, which is rate limited (Code Review Rules, ADR-0005).
- Messages don't reveal whether an account exists or an address is allowlisted.

## Session expiry and returning

A session that ends mid-task sends the person here from any server call, then to `/` ([invitations and access](../patterns/invitations-and-access.md#session-expiry)). No new authentication challenge (re-authentication, second factor) exists; it's deferred.

## Tests

[`e2e/slice.spec.ts`](../../../apps/app/e2e/slice.spec.ts), [`auth.setup.ts`](../../../apps/app/e2e/auth.setup.ts) (real sign-up and sign-in, budgeted by the rate limit), [`visual/auth.visual.ts`](../../../apps/app/visual/auth.visual.ts) (both themes, both widths, Turnstile's host masked).
