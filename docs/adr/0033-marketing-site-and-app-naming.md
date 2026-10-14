# ADR-0033: A static marketing site on the apex, a shared static-site pipeline, and the app deployable named `app`

Status: Proposed · Date: 2026-10-14

Adds a third Worker under [ADR-0002](0002-single-tanstack-start-worker.md) and [ADR-0007](0007-defer-cloudflare-products.md), following [ADR-0027](0027-polyglot-service-and-repository-boundaries.md)'s criteria and checklist and [ADR-0028](0028-public-docs-site.md)'s pattern. Supersedes in part [ADR-0029](0029-releases-deploys-and-rollback.md) decision 1 (the component and tag name). Takes the "plans and limits" row of ADR-0028's Deferred table. Research: `.local/research/landing-and-rename-2026-10-14.md` (git-ignored, kept by the owner).

## Context

- A product built from this template needs a public front door: what it is, what it costs, how to get in. Today the apex `aaronlabr.dev` serves nothing, and `app.aaronlabr.dev/` redirects a signed-out visitor to `/login`.
- The pieces it needs already exist elsewhere:
  - The plans, limits and trial live in `modules/billing/policy.ts` (ADR-0020). Price **amounts** live only in Polar's dashboard (ADR-0022).
  - The legal pages are app routes (`/privacy`, `/terms`, `/subprocessors`).
  - Sign-up is allowlisted until milestone D (ADR-0032 decision 2).
- A marketing site has the docs' profile: public, static, no tenant data, no secret, edited more often than the app. ADR-0028's reasons for a separate assets-only Worker apply unchanged.
- With two static sites, ADR-0027's trigger for reusable workflows ("two or more deployables with the same build and deploy shape") is met. Copying the docs pipeline would duplicate four workflows and five scripts whose checks are the security boundary (ADR-0028 "Preview isolation").
- `web` names the app deployable everywhere: the `apps/web` path, the package (`pnpm --filter web`), release-please's component and the tags `web-vX.Y.Z` (ADR-0029 decision 1). Next to `docs` and a marketing site, `web` is ambiguous: all three serve the web. The ADRs already call it "the app Worker", and it serves `app.<zone>`.
- release-please facts, checked in the source of the version the pinned `release-please-action` v5.0.0 bundles (2026-10-14):
  - The previous release is the GitHub Release whose tag has this component and the manifest's version, then the tag `<component>-v<version>`.
  - If neither exists, the manifest's version is still used. Commits are collected back to `bootstrap-sha`, which is consulted **only** when no release of the component is found.
- The live production version is `web-v0.2.0` (commit `5b7ede2`, #102). It had no pending migrations, so no `pre-migrate-*` restore point exists (ADR-0029 Notes).

## Decision

### Marketing site

1. **`apps/site`: an Astro static site**, without Starlight, served by its own Worker with **static assets only**. Its rules are the docs Worker's (ADR-0028 decision 1):
   - no `main`, bindings, vars, secrets or `previews` block;
   - `workers_dev: false`, `preview_urls: false`, `not_found_handling: "404-page"`, `html_handling: "auto-trailing-slash"`;
   - the Custom Domain is its only route;
   - security headers in `public/_headers`.

   The Worker is `<app Worker>-site` (here `saas-foundation-site`), on the **apex** (`aaronlabr.dev`). `scripts/check-bindings.mjs` enforces all of this, as it does for the docs.

2. **Hostnames:** the apex is the site, `app.<zone>` the app (unchanged), `docs.<zone>` the docs. `www` isn't served. A `www` → apex redirect is a zone Redirect Rule the owner may add in the dashboard; it isn't code.
3. **No shared session.** Better Auth's cookies stay host-only on `app.<zone>` (no cross-subdomain cookies). The site never sees whether a visitor is signed in, so its calls to action are plain links. The auth trust boundary doesn't change.
4. **Pages:** a landing page (`/`), pricing (`/pricing`) and a 404. The footer links to the app's legal pages and to the docs; the legal text stays in the app, one copy (moving it is Deferred).
5. **Calls to action follow the sign-up mode**, one constant in the site's config:
   - `allowlist` (today): "Request access" (a `mailto:` to the site's contact address) and "Sign in" (`app.<zone>/login`);
   - `open` (milestone D, its own ADR): "Get started" (`app.<zone>/signup`) and "Sign in".

   The site can't read `SIGNUP_MODE`, and must not try.

6. **Pricing data never drifts from `policy.ts`** (ADR-0020):
   - **Plans:** `apps/app/scripts/export-plans.ts` writes what the pricing page may show to the committed `apps/site/src/data/plans.json`: each plan's key, name, limits and features, its purchasable prices (key and interval), the default plan and the trial days. `pnpm check` fails when the committed file differs from a fresh export (ADR-0027's contract pattern). The site imports the JSON; it never imports app code.
   - **Amounts:** they stay in Polar. The site keeps them, for display only, in `apps/site/src/data/prices.json` (price key → amount in minor units + ISO currency). The site's build fails if a purchasable price has no amount, or an amount names a price key that isn't purchasable.
   - The owner keeps `prices.json` equal to the Polar dashboard (runbook "Site"). No Polar credential reaches the site's build.
7. **SEO:** a sitemap (`@astrojs/sitemap`), `robots.txt`, canonical URLs, and description and Open Graph meta on every page.
8. **Analytics:** none in the page. The zone's analytics show traffic, so the privacy policy's "no advertising or analytics trackers" stays true. Cloudflare Web Analytics is Deferred.

### Shared static-site pipeline

9. **One pipeline for both static sites.**
   - The docs' build, preview, deploy and rollback become reusable workflows (`static-build.yml`, `static-preview.yml`, `static-deploy.yml`, `static-rollback.yml`, `on: workflow_call`), with the site's app directory as input.
   - Each site keeps thin caller workflows: `docs*.yml` (unchanged names and triggers) and `site*.yml`. Each caller owns its path filters, its concurrency lock and its `main`-only environment.
   - `scripts/docs/` becomes `scripts/sites/`, taking the site's app directory. The per-site differences are the files its build must contain and the URLs its smoke test checks.
   - What ADR-0028 enforces doesn't change: no job holding a token runs PR code, the PR's build is data checked by `main`'s scripts, and **each token reaches one Worker**. The site gets environments `site` (`CLOUDFLARE_SITE_TOKEN`, Workers Editor on `saas-foundation-site` only) and `site-preview` (`CLOUDFLARE_SITE_PREVIEW_TOKEN`, on `saas-foundation-site-preview` only).
   - Deploys are continuous at 100%, versions tagged `site-<sha7>` (ADR-0029 decision 5).
   - The app's preview pipeline skips PRs that change only `apps/docs/**` and `apps/site/**`. release-please excludes `apps/site` as it does `apps/docs`.

### The app deployable is named `app`

10. **Rename `web` to `app`:**
    - the path `apps/web` → `apps/app`;
    - the package `web` → `app` (`pnpm --filter app`);
    - the release-please component `web` → `app`, so tags are `app-vX.Y.Z`;
    - the changelog `apps/app/CHANGELOG.md`.

    The Worker name stays `saas-foundation`: it's product-specific, and the new-product runbook renames it per product. Renaming the live Worker would mean a new Worker, a domain move and every secret again, for no gain. Earlier ADRs keep `apps/web` and `web-v*` as history; they mean `apps/app` and `app-v*` from here on.

11. **Release continuity, without compatibility code:**
    - **release-please:** `bootstrap-sha` becomes `web-v0.2.0`'s commit (`5b7ede2`). Finding no `app` release, release-please takes 0.2.0 from the manifest and collects the commits after it. The first app release is 0.3.0 or 0.2.1, tagged `app-v…`. `bootstrap-sha` is inert once an `app` release exists, so nothing has to be removed later.
    - **Scripts and workflows** accept only `app-v*`. No dual-prefix matching, no alias tags.
    - **One expected hold:** the live version's Cloudflare tag is `web-v0.2.0`, which doesn't match `app-v*`, so the first app release sees an "untagged" live version and holds at 0% (ADR-0029 decision 3, step 8). The owner checks it and runs `promote`. This happens once, by the existing rule, and needs no code.
    - **`web-v*` releases stay as history** (immutable releases). They can't be **redeployed** by `release.yml`, whose resolve step and artifact paths are `app`'s. Going back to one is a **rollback** by version id (`rollback.yml`). Its commit comes from the version message, so the breaking-release guard still applies; health is checked as `ok` only, as for an untagged version.
    - **Restore points** are matched as `pre-migrate-app-v*`. No `pre-migrate-web-v*` branch exists (see Context).

## Alternatives

| Option                                                                          | Why not                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing and pricing as routes in the app Worker                                 | Marketing on `app.<zone>`, which should stay out of search. Every visit invokes the Worker. Every copy edit goes through the release PR, a 0% candidate and promotion, and marketing code ships in the app's bundle. Its one gain, importing `policy.ts` directly, is covered by decision 6. |
| Marketing pages inside `apps/docs` (one Astro project, two hostnames)           | Mixes two lifecycles and two designs in one build. Starlight's layout fights a landing page, and ADR-0028 decision 1 serves the docs only on `docs.<zone>`.                                                                                                                                  |
| Copying the docs workflows and scripts for the site                             | Two copies of the checks that keep a PR's build from reaching production bindings, which will drift. ADR-0027's trigger for reusable workflows is met.                                                                                                                                       |
| Price amounts in `policy.ts`                                                    | ADR-0020/0022 keep amounts and currency in the provider's dashboard. A second copy in the app would look authoritative and still drift from Polar.                                                                                                                                           |
| Amounts fetched from Polar at build time                                        | Puts a Polar credential in the site's build, which today holds no secret at all.                                                                                                                                                                                                             |
| Keep the component `web`, rename only the path and package                      | One permanent inconsistency between the directory and every tag. `bootstrap-sha` makes the real rename cost one line.                                                                                                                                                                        |
| `last-release-sha`, alias `app-v0.2.0` tags, or scripts accepting both prefixes | `last-release-sha` is never ignored and must be removed later. An alias gives one release two names. Dual prefixes are compatibility code in the release guards. `bootstrap-sha` already does the job and goes inert by itself.                                                              |
| `console`, `dashboard`, `platform`                                              | `app` matches the hostname and the ADRs' own wording; the others undersell (dashboard) or say nothing (platform).                                                                                                                                                                            |

## Preview isolation (invariant 15)

As ADR-0028: **a site preview binds nothing.** `check-bindings.mjs` keeps `apps/site/wrangler.jsonc` assets-only. The preview and deploy jobs use the default branch's config and scripts and take only the PR's static `dist/`, as data: no symlinks, no `.dev.vars*`, `.env*` or Wrangler config. Deleted Previews keep serving (ADR-0021); a site PR contains nothing the owner wouldn't publish.

## ADR-0027 checklist

- **Criteria met:** 5, deployment lifecycle (copy changes deploy on merge, the app releases through release PRs); 6, security isolation (public, credential-free, outside the app's trust boundary); 4, failure isolation (the site stays up when the app or database is down).
- **Ownership:** the owner. The runbook gets a section "Site": owner setup, prices, token rotation, rollback.
- **Platform:** Workers Static Assets, no script, so asset requests are free.
- **Deployment:** the shared pipeline of decision 9.
- **Security:** no tenant data, no credential, no secret. The output is scanned with `scan-client-bundle.sh` (invariant 8). `_headers` sets `X-Content-Type-Options`, `Referrer-Policy` and a CSP without inline scripts.
- **Testing:**
  - CI builds the site and asserts `index.html`, `pricing/index.html`, `404.html`, `robots.txt`, the sitemap and `_headers`.
  - The plans drift check runs in `pnpm check`, and the prices check in the site's build.
  - The deploy smoke-tests `/`, `/pricing/` and `/version.json`.
- **Observability:** as the docs: no invocations, so the smoke test and zone analytics.
- **Maintenance:** pnpm workspace, Node 24. Astro is in Dependabot's `astro` group with the docs.

## Rollout

1. **This ADR and the rename** (one PR, `refactor`): it ships with the next release, which carries #119/#120 too. That release holds at 0% once (decision 11); the owner promotes it.
2. **The shared pipeline** (`refactor(ci)`): the docs keep working with the same workflow names, environments and secrets. Verified by a docs PR preview and the next docs deploy.
3. **`apps/site`** (`feat(site)`). Owner, before the first deploy:
   - create `saas-foundation-site` and `saas-foundation-site-preview`, the two per-Worker tokens and the environments `site` and `site-preview` (`main` only);
   - set the real amounts in `prices.json` and route the contact address;
   - attach the apex Custom Domain with one manual `wrangler deploy` (per-Worker tokens can't manage domains).

## Deferred

| Decision                                | Options                                                                                          | Trigger                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `noindex` on the app                    | `X-Robots-Tag` or a robots meta on every app route except the legal pages                        | the app appears in search results, or with the site's first deploy, whichever comes first |
| Cloudflare Web Analytics                | its cookieless beacon (CSP allowance, privacy text and subprocessor registry updated)            | a page-level metric the zone's analytics can't answer                                     |
| Waitlist                                | a tenant-less table behind Turnstile and the rate limiter, with consent text; or a form provider | more requests than a mailbox handles, or public launch                                    |
| `?plan=` through sign-up into checkout  | carry the price key from `/signup` through organization creation to checkout                     | milestone D (public sign-up)                                                              |
| Legal pages on the site                 | move the routes and `lib/legal.ts` to `apps/site`, redirects from the app                        | the legal text has to be reachable while the app is down, or the app and site diverge     |
| Status page, public changelog           | a hosted status page; the release changelog rendered on the site at build time                   | paying customers; the first release customers should read about                           |
| `www`                                   | a zone Redirect Rule (dashboard) to the apex                                                     | the owner wants `www` to resolve                                                          |
| A third static site, or i18n/versioning | another caller of the shared pipeline; Astro's i18n                                              | its own ADR                                                                               |

## Consequences

- Three deployables with distinct names: `app`, `docs`, `site`. Static sites share one pipeline, so a fix to its checks reaches both.
- Pricing has one source per fact: plans and limits from `policy.ts`, amounts from Polar (mirrored by hand, checked for completeness).
- The rename touches every path in workflows, scripts, the ESLint config, `AGENTS.md` and the runbooks once. Redeploying a pre-rename release goes through rollback, not `release.yml`.
- The owner has two more Workers, two tokens and two environments to set up.
