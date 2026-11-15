# Troubleshooting

Start from what you see. Each entry gives the context it applies to, what to look at safely, the likely causes (hypotheses until the evidence confirms one), the next step and who can take it, and when to stop. Detailed procedures stay in the [runbooks](../runbooks/README.md) and [`docs/testing.md`](../testing.md#troubleshooting); this page links them.

Ground rules for every entry:

- **A status code isn't a diagnosis.** A 404 can mean an unknown tenant, no membership, a foreign resource or a typo, on purpose (invariant 5). Find the evidence before naming a cause.
- **Don't widen what's visible to diagnose it.** Don't make a 404 say why, loosen the CSP, turn off a check, or ask anyone for cookies, tokens, request bodies or full logs (ADR-0015). Use the logged `event` names in [`server/log.ts`](../../apps/app/src/server/log.ts) and the IDs a page already shows.
- **Don't retry a mutation blindly.** If a write may have happened (a timeout, a lost response, a provider call that didn't answer), find out whether it did first. After a migration, release, deploy, rollback or other external mutation, anything but an observed clean success is UNKNOWN: report it with the raw output and don't retry without the owner (AGENTS.md "Working rules").
- **Production and provider dashboards are the owner's.** An agent stops at the read-only evidence available to it and reports.

## Local setup fails or port 3000 is in use

**Context:** a local checkout, running `pnpm dev`, `pnpm test:e2e` or the first-change guide.

**Look at:** the exact failing command and its first error; `node --version` against `.node-version`; `pnpm --version` against `packageManager`; `docker ps` for the Postgres container on `127.0.0.1:5432`; whether `apps/app/.dev.vars` exists.

| Observation                                                      | Possible cause                                                                | Next step                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev` fails because port 3000 is taken (`--strictPort`)     | another dev server, an E2E run, or another checkout's server                  | **Stop.** Don't switch ports (auth origins depend on 3000) and don't kill processes yourself. Tell the user the port is in use and recommend `kill -9 $(lsof -t -i:3000)` (AGENTS.md "Port 3000 busy"). If an E2E run holds it, wait for the test lock. |
| Connection refused on 5432, or migrations find an empty database | Postgres not started, or a worktree started its own empty one                 | `pnpm db:up` from the main checkout, then `pnpm db:migrate` ([first change](../guides/first-change.md#3-start-the-database-and-the-app))                                                                                                                |
| E2E refuses to start: pending migrations                         | the dev database `app` is behind the code                                     | `pnpm db:migrate`                                                                                                                                                                                                                                       |
| Sign-in or sign-up forms stay disabled                           | not hydrated yet, or Turnstile has no key (`.dev.vars` missing the test keys) | compare `.dev.vars` with `.dev.vars.example`; a 503 with `auth.turnstile_misconfigured` confirms it                                                                                                                                                     |
| `BETTER_AUTH_SECRET missing from apps/app/.dev.vars` (E2E)       | `.dev.vars` not created                                                       | create it from the example ([first change](../guides/first-change.md#2-install-and-configure))                                                                                                                                                          |

**Stop when:** the fix needs another user's process stopped, a different port, or a credential you don't have. Report what you saw.

## Signed in, but the tenant page is a 404

**Context:** `/t/<slug>/…` shows "Not found. This page doesn't exist or you don't have access to it." while you're signed in. The page is the same for every case on purpose ([`__root.tsx`](../../apps/app/src/routes/__root.tsx) `NotFound`, invariant 5).

**Look at, as that user:** the slug in the URL, character by character; the organization menu in the tenant header, which lists your other organizations (`/` sends you to your first one); whether the page under the tenant is a project id you copied from another organization. In a local or test database only, the developer can query `organization` by slug and `member` by user.

| Possible cause                                     | How to tell                                         |
| -------------------------------------------------- | --------------------------------------------------- |
| A typo or an old slug                              | the organization isn't in your list under that slug |
| You're not a member (never were, removed, or left) | the organization isn't in your list at all          |
| The resource belongs to another organization       | the tenant's other pages work; only that id fails   |
| The organization was deleted                       | not in your list; a local database has no row       |

**Next step:** open the organization from your own list. If you should be a member, an owner or admin of that organization invites you again. Code paths: `getTenantContext` ([`server/context.ts`](../../apps/app/src/server/context.ts)) and the resource check before `authorize` ([domain model](../architecture/domain-model.md#how-a-request-is-authorized)).

**Don't:** add a different message for "exists but you're not a member", or tell someone outside the organization whether it exists. A 403 is only ever for a member whose role lacks a capability.

**Stop when:** the user is a member by every check you can make and still gets 404: that's a defect report with the route, the time and the steps, not a fix to try in production.

## Invitation acceptance fails

**Context:** `/invite/<id>`, "Accept invitation".

| Observation                                           | Possible cause                                                                                                                                                                | Next step                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Sent to the sign-in page first                        | not signed in (expected)                                                                                                                                                      | sign in or sign up with the invited address; the link brings you back                                    |
| "not found" after clicking Accept                     | signed in as a different address than the one invited; or the invitation expired, was revoked or was already used. These are the **same 404** on purpose                      | check "Signed in as …" on the page; sign in with the invited address; otherwise ask for a new invitation |
| "not found" for an account with an unverified address | invitation actions need a verified address (ADR-0016); only a session from before verification was enforced can still be unverified, and the app answers it with the same 404 | sign out, sign in again (it refuses and resends the verification link), verify, then accept              |
| 403 "no free seats on its plan"                       | the organization is at its plan's member limit                                                                                                                                | an owner removes a member or upgrades                                                                    |

**Inviter's side:** the members page lists pending, unexpired invitations; one that's gone from the list expired, was accepted or was revoked. The invite page returns the link itself, so a missing email doesn't block anything ([email](../integrations/email.md)).

**Stop when:** the right, verified account gets 404 on a fresh invitation from the list: report it with the time; don't look up or reveal the invitation's state to the recipient.

## Checkout returned, but access is unchanged

**Context:** after paying in Polar's checkout, the billing page still shows the old plan.

**What it means:** arriving back on `/t/<slug>/billing?checkout=success` proves nothing; the plan changes only when Polar's webhook has been verified and applied ([billing](../integrations/billing.md#four-states-that-are-not-the-same-thing)).

| Look at                                | Who                      | Tells you                                                                                                                |
| -------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Reload the billing page after a minute | the organization's owner | whether the webhook has arrived since                                                                                    |
| Polar's endpoint delivery log          | the repository owner     | whether a `subscription.*` delivery was sent and what it answered (`applied`, `duplicate`, `stale`, `unlinked`, 4xx/5xx) |
| Logged `billing.webhook.*` events      | the repository owner     | unconfigured, bad signature, provider unavailable, failed, unlinked, unknown price                                       |

**Next step:** follow runbook ["Re-sync one subscription from Polar"](../runbooks/README.md#re-sync-one-subscription-from-polar) (owner). Don't start a second checkout to "try again": the first may have completed, and the organization can hold only one subscription.

**Stop when:** the delivery log and the subscription in Polar disagree with the app after a re-sync; record the mismatch in the runbook as it says.

## An email doesn't arrive

**Context:** verification, password reset or invitation.

| Environment | Check                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local       | the `pnpm dev` terminal: `EMAIL_DELIVERY=console` prints the message there. Nothing printed and `email.misconfigured` logged: the console mode is refused outside a localhost dev build.                                                               |
| Preview     | expected: previews send no email, and verification is off there                                                                                                                                                                                        |
| Production  | owner: `email.delivery_disabled` (delivery unset), `email.misconfigured`, `email.send_failed` in the logs; otherwise the binding accepted it, which isn't delivery: spam folder, then runbook ["Email"](../runbooks/README.md#email-adr-0016-adr-0024) |

**Next step:** an invitation's link can be passed on by the inviter (the invite page shows it); verification and reset can be requested again. Never paste a link with a token into an issue or chat.

## The browser refuses a style (CSP)

**Context:** an E2E or visual test fails with a Content-Security-Policy refusal, or the console shows one. Every E2E test fails on any refusal ([`e2e/fixtures.ts`](../../apps/app/e2e/fixtures.ts)).

**Look at:** the refused directive (`style-src-elem` for a `<style>` element, `style-src-attr` for a `style` attribute) and which component renders it; whether a dependency was just bumped (`sonner`, `@base-ui/react`, React).

| Possible cause                                                 | Next step                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A sonner, Base UI or React bump changed an injected style      | `pnpm csp:hashes`; `pnpm check` fails until you do. The diff is a CSP change and is reviewed as one (ADR-0046 decision 4).                                                                                                          |
| Page code set a `style` attribute rendered on the server       | remove it; use token classes (AGENTS.md "UI": no `style`)                                                                                                                                                                           |
| A Base UI component that renders value-dependent inline styles | it's one of the six excluded components (slider, progress, meter, scroll-area, accordion, collapsible), which lint refuses; don't use it ([design system](../design-system/foundations/accessibility.md#csp-and-what-it-rules-out)) |
| WebKit's native `<select>` stylesheet (visual tests only)      | the one allowed exclusion, once per page URL ([`docs/testing.md`](../testing.md))                                                                                                                                                   |

**Never:** add `unsafe-inline`, a style nonce, or another hash by hand. Any other style source is a CSP change for the owner ([ADR-0045](../adr/0045-app-security-headers.md) decision 5).

## Database privilege errors (42501)

**Context:** a test or request fails with `permission denied for table …` (SQLSTATE `42501`).

| Possible cause                                              | How to tell                               | Next step                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A new table without its grant migration                     | `database-role.test.ts` fails on `GRANTS` | add the grant in a custom migration and the `GRANTS` entry ([recipes](../architecture/recipes.md)) |
| Code reaching the `archive` schema                          | the statement names `archive.*`           | it's owner-only by design (ADR-0039): don't grant it                                               |
| A statement the runtime role must not run (DDL, `TRUNCATE`) | the statement is DDL                      | it belongs in a migration, run as the owner                                                        |

**Never** grant broader privileges or connect the app as the owner to make it pass (invariant 7). In production, a 42501 is the owner's: runbook ["Runtime role"](../runbooks/README.md#runtime-role-adr-0038).

## Tests fail only when run as a suite

**Context:** a test passes alone but fails in `pnpm test` or `pnpm test:e2e`.

**Look at first, before suspecting the code:**

- Was it run through `scripts/test-lock.sh`? Two runs at once on the same machine share `app_test`, the dev database and port 3000, and interfere. Rerun through the lock and read the full log it names.
- The machine's load (`cat /proc/loadavg`): timeouts under load move between tests. [`docs/testing.md`](../testing.md#troubleshooting) gives the fewer-workers, longer-timeout command.
- E2E "Too many requests": the run used up the login rate limit; a new test that signs in for real spends budget ([`docs/testing.md`](../testing.md#testing-a-product-feature)).
- A test that depends on data another test created: tests create their own organizations (`createOrg`) and rows.

**Next step:** rerun once under the lock with the load low, and report both runs. If it still fails the same way, it's a real failure: diagnose it like any other failure, from its log.

**Never** skip, weaken or delete the test to get a green run (AGENTS.md "Working rules").
