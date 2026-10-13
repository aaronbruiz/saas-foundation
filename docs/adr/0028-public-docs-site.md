# ADR-0028: Public product docs: a static Starlight site on its own assets-only Worker

Status: Proposed · Date: 2026-10-13

Adds a second Worker under [ADR-0002](0002-single-tanstack-start-worker.md) and [ADR-0007](0007-defer-cloudflare-products.md) ("second Worker: … isolation need"), following [ADR-0027](0027-polyglot-service-and-repository-boundaries.md)'s criteria and checklist. Extends [ADR-0006](0006-toolchain.md)'s toolchain. Research, sources and measurements: `.local/research/docs-hosting.md` (2026-10-13; git-ignored, kept by the owner).

## Context

- Each product built from this starter needs public docs for **its customers** (not docs about the starter). Today there is nowhere to put them: `apps/web` is the authenticated app on `app.<zone>`, and its production deploys are manual, owner-run and gated by the data gate (runbook "First production deploy").
- Docs differ from the app on every axis that matters here. They're public, static, hold no tenant data and need no database or secret. They change more often than the app and are edited by people who shouldn't need to touch the app's deploy.
- Peers serve `llms.txt` plus a raw Markdown twin of every page. Checked 2026-10-13: Supabase, Neon, PostHog, Stripe, Vercel, Resend and Linear serve `<route>.md`; Cloudflare serves `<route>/index.md`. Hosted docs platforms (Resend on Mintlify) and Cloudflare also expose a docs MCP server.
- Cloudflare facts ([Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/), 2026-10-13):
  - an account-owned token can carry Workers **Editor** on **specified Workers**: it can deploy them but can't create or delete them;
  - "Custom Domains do not currently support per-Worker roles";
  - deploying a Worker needs no permission on the resources it binds.
  - Requests to static assets are free and don't invoke a Worker.
- `scripts/check-bindings.mjs` refuses any second Wrangler config until it's taught about it (invariant 14).
- **Owner decisions taken before this ADR** (2026-10-13):
  - The docs are for each product's customers, live on `docs.<product>`, and are served by `apps/docs`, an assets-only Worker deployed independently.
  - Starlight is the default framework unless Fumadocs on TanStack Start clearly wins. Search is static Pagefind. Docs are latest-only and English-only, but the framework must allow versioning and i18n later.
  - Agents get `llms.txt` plus a raw `.md` per page.
  - Docs previews are separate from the Neon pipeline.
  - There's no shared UI or brand package, and the site is self-hosted only.
  - Internal developer docs stay as Markdown in the repo.
  - Previews deploy to a separate preview Worker; draft docs on public `workers.dev` URLs are acceptable, and a docs PR contains nothing the owner wouldn't publish.
  - The web preview skips docs-only PRs, in the same follow-up PR.
  - The foundation deploys its own docs site, `docs.aaronlabr.dev`, with placeholder content, so the template is exercised before a product needs it.
  - Starlight is pinned exactly, in its own Dependabot group.
  - Releases, deploys and rollback for both Workers follow [ADR-0029](0029-releases-deploys-and-rollback.md); docs deploy continuously.

## Decision

1. **`apps/docs`: an Astro + Starlight static site**, built to `dist/` and served by its own Worker, with **static assets only**. Its config has no `main` script, no bindings, no vars and no secrets. The production Worker is `<product>-docs` (here `saas-foundation-docs`), served only on the Custom Domain `docs.<product zone>`, with `workers_dev: false` and `preview_urls: false`. `not_found_handling: "404-page"`, `html_handling: "auto-trailing-slash"`. Redirects and security headers go in `public/_redirects` and `public/_headers`, which static assets apply natively.
2. **Search: Pagefind**, as built into Starlight (indexed at build time; no service, no binding, no key).
3. **Agent formats:** `/llms.txt` (an [llmstxt.org](https://llmstxt.org) index) and `<route>.md` (the page's Markdown source, `text/markdown`) come from two small Astro endpoints in `apps/docs/src/pages/`, not a plugin. No content negotiation on `Accept: text/markdown`: it needs a Worker script or Cloudflare's Markdown for Agents, which is Pro and up, and the zone is Free (ADR-0017).
4. **Latest-only, English-only.** English is Starlight's `root` locale, so adding locales later doesn't move existing URLs.
5. **Previews** run on a separate Worker, `<product>-docs-preview` (here `saas-foundation-docs-preview`), as Wrangler Preview URLs on `workers.dev`, one per PR (`pr-N`). They don't use the Neon/Hyperdrive pipeline of ADR-0021, and they build and deploy only when the docs build can change (see "CI and credentials").
6. **Production deploys from CI** on `push` to `main`, at 100%, with no release PR, tags or 0% stage (ADR-0029 decision 5), plus a `workflow_dispatch` redeploy of a given commit and a rollback workflow (ADR-0029 decision 6). The app Worker's deploy is ADR-0029's release flow. CI uses `wrangler versions upload --tag docs-<sha7> --message <sha>` + `wrangler versions deploy`, which never change routes or domains, and the build writes a static `/version.json` (commit SHA, build time). The owner attaches the Custom Domain with one manual `wrangler deploy`, because custom domains can't be managed with a per-Worker token.
7. **Brand:** the docs theme sets Starlight's CSS custom properties in `apps/docs/src/styles/`. There's no shared package (see "Deferred").
8. **Internal developer docs** (ADRs, runbooks, `AGENTS.md`) stay as Markdown in the repo, read on GitHub and by agents. No rendered internal site.

## Alternatives

| Option                                                                | Why not (evidence in the research file)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fumadocs on TanStack Start (same stack as `apps/web`)                 | Not a clear win. It has no Pagefind integration: its scaffolder offers Orama, Orama Cloud, Algolia, Meilisearch, Typesense and Mixedbread, and the default Orama static index is downloaded whole. Its TanStack Start template builds through Nitro with an SPA shell and pins TypeScript 7, `@types/node` 26 and a Nitro beta, against ADR-0006. It built 100 pages in 11.7 s, against Starlight's 4.4 s. It is stronger on first-party `llms.txt`/`.md` and on semver stability (16.x against Starlight's 0.x). |
| Docs inside `apps/web` (routes in the app Worker)                     | Every docs edit would need a production app deploy, which is manual and data-gated. Docs would share the app's failure domain and bundle, and a different hostname would need a second route on the app Worker. It would also force Fumadocs or hand-built docs into TanStack Start.                                                                                                                                                                                                                              |
| Nimbus (`@cloudflare/nimbus-docs`, Astro)                             | Runs developers.cloudflare.com since 2026-07-21 (it replaced Starlight there) and ships Markdown twins, `llms.txt` and versioning. Against it: pre-1.0 ("Work in progress"), three months old, and an "owned source" scaffold, so fixes don't arrive as dependency updates. Revisit in "Deferred".                                                                                                                                                                                                                |
| Docusaurus, VitePress                                                 | Mature static generators; no advantage here over Starlight (Astro and Vite already fit the workspace), and React or Vue weight without a reason.                                                                                                                                                                                                                                                                                                                                                                  |
| Mintlify, GitBook (hosted)                                            | Ruled out (self-hosted only). They offer `llms.txt`, `.md` and a docs MCP out of the box, but content and hosting would sit outside our accounts and CI.                                                                                                                                                                                                                                                                                                                                                          |
| Algolia DocSearch, Cloudflare AI Search                               | A third-party service or a new Cloudflare product and binding. Pagefind needs neither at this size.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Previews as aliases on the production docs Worker (Astro docs' model) | The token would have Editor on the production docs Worker in a PR-triggered job, which mixes ADR-0013's T1 and T2.                                                                                                                                                                                                                                                                                                                                                                                                |
| Cloudflare Pages                                                      | ADR-0002 chose Workers Static Assets; no Pages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Preview isolation (invariant 15)

Invariant 15 is met trivially: **a docs preview binds nothing**. It has no Hyperdrive, no Neon branch, no secret and no email, so there's no production data to reach and nothing to revoke when the PR closes. That's why docs previews don't need ADR-0021's per-PR branch and Hyperdrive config.

That holds only if the deployed config has no bindings, so it's enforced rather than assumed:

- `check-bindings.mjs` allows `apps/docs/wrangler.jsonc` and fails if it has a `main`, any binding, `vars`, `env` or a `previews` block.
- The deploy job uses the **default branch's** `apps/docs/wrangler.jsonc` and takes only the static `dist/` from the PR's artifact, as data. It refuses symlinks, `.dev.vars*`, `.env*` and any Wrangler config inside the artifact.

Without those two checks the docs tokens would matter: a per-Worker Editor token can deploy a Worker bound to any Hyperdrive id, production's included (the same residual risk the runbook records for the web preview token).

Deleted Previews keep serving (ADR-0021). For docs this only means an old PR's draft pages stay reachable on `workers.dev`. Nothing private goes into a docs PR.

## CI and credentials (ADR-0013, ADR-0019, ADR-0021)

| Workflow / job                        | Trigger                                            | Tier | Environment (`main` only) and secret                                                              |
| ------------------------------------- | -------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `docs.yml` build                      | `pull_request`, `push: main`; paths below          | T0   | none. Builds, scans `dist` with `scripts/scan-client-bundle.sh`, uploads `dist` for same-repo PRs |
| `docs-preview.yml` deploy             | `workflow_run` of `docs.yml` (default-branch code) | T1   | `docs-preview`: `CLOUDFLARE_DOCS_PREVIEW_TOKEN`, Workers Editor on `<product>-docs-preview` only  |
| `docs-preview.yml` cleanup (tidiness) | `pull_request_target: closed`                      | T1   | `docs-preview`, same token                                                                        |
| `docs-deploy.yml`                     | `push: main`; paths below                          | T2   | `docs`: `CLOUDFLARE_DOCS_TOKEN`, Workers Editor on `<product>-docs` only                          |
| `docs-deploy.yml` redeploy            | `workflow_dispatch` on `main` with a commit input  | T2   | `docs`, same token                                                                                |
| `rollback.yml` (docs)                 | `workflow_dispatch` on `main` (ADR-0029)           | T2   | `docs`, same token                                                                                |

- **Paths** that trigger the build and both deploys: `apps/docs/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the root `package.json`, `.node-version`, the docs workflows and `scripts/check-bindings.mjs`. Lockfile- and workspace-only changes reach the docs build too (#87, #88).
- **No job that holds a token runs PR code.** The preview job checks out the default branch, installs its lockfile with caches off and treats the artifact as data (ADR-0021's pattern). The production job builds from `main`.
- **Each token reaches one Worker.** They live in their own `main`-only environments, never in `production` (which holds the Neon and R2 production keys) and never at repo level. Neither token can create Workers, so the owner creates both Workers once.
- **CI production deploys** are introduced together with ADR-0029, which covers the app Worker. Here the token is limited to a Worker with no bindings.
- **Docs-only PRs shouldn't spend a preview Neon branch** (10 per preview project, ADR-0021). The follow-up PR makes the web preview pipeline skip PRs that change only `apps/docs/**`.

## ADR-0027 checklist

- **Criteria met:**
  - **5, deployment lifecycle:** docs release on every merge, while the app releases by a manual, data-gated owner sequence.
  - **6, security isolation:** a public, credential-free site on its own hostname, outside the app's trust boundary and WAF rules.
  - **4, failure isolation:** the docs stay up when the app or database is down.
- **Ownership:** the owner. The runbook gets a section "Docs" (owner setup, token rotation, rollback with `wrangler rollback` run from `apps/docs`).
- **Platform:** Cloudflare Workers Static Assets. No script, so asset requests are free and never invoke a Worker.
- **Deployment:** the workflows above. Preview isolation is covered in its own section.
- **Security:** no tenant data, no database credential, no secret. Public content only, scanned with `scan-client-bundle.sh` (invariant 8). `_headers` sets `X-Content-Type-Options`, `Referrer-Policy` and a CSP compatible with Pagefind.
- **Testing:**
  - CI builds the site and asserts that `llms.txt`, a `.md` twin, `404.html` and `pagefind/` exist.
  - `pnpm check` covers `apps/docs`: Prettier, plus `astro check` as its `typecheck`.
  - The deploy smoke-tests `/`, `/llms.txt` and one `.md`.
  - The repo has no branch protection (ADR-0021), so merges are gated as they are today.
- **Observability:** with no script, there are no invocations and nothing for Workers Logs to record. ADR-0015's request id and logs don't apply. The health check is the post-deploy smoke test, and the zone's analytics show traffic.
- **Maintenance:** pnpm workspace, Node 24; Dependabot gets a separate `astro` group because Starlight is 0.x and its minor releases can break.

## Toolchain (extends ADR-0006)

- **Astro 7** (`astro` 7.3.x) and **Starlight** (`@astrojs/starlight` 0.42.x, pinned exactly while it's 0.x). Pagefind comes with Starlight (`pagefind` ^1.5.2). Astro 7 uses Vite ^8.3, the same major as `apps/web`, and needs Node ≥ 22.12.
- **`astro check`** (`@astrojs/check`, peer `typescript ^5 || ^6`) is `apps/docs`'s `typecheck`. TypeScript stays `~6.0`. Checked 2026-10-13: `astro check` with TypeScript 6.0 reported 0 errors.
- **Prettier** formats `.md`/`.mdx` natively. `prettier-plugin-astro` comes in only when `.astro` files are added. ESLint keeps its current globs and ignores `apps/docs/.astro` and `dist`.
- **Wrangler** `^4.147` as in ADR-0006, the same major as `apps/web`.

## Deferred

| Decision                                              | Options                                                                                                                                                                                                                                                       | Trigger                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Docs MCP server                                       | a `search_docs`/`get_page` tool in the product's own MCP server; or a script on the docs Worker serving MCP over the Pagefind index or `llms-full.txt` (the Worker stops being assets-only, so this needs a new ADR); hosted platforms do this out of the box | customers ask to use the docs from their agents and `llms.txt`/`.md` doesn't serve them, **or** the product ships its own MCP server |
| Reference pages generated from code: plans and limits | export `modules/billing/policy.ts` to JSON at build time with a drift check (ADR-0027's contract pattern); or move the policy data into a package that both apps import; or hand-written pages checked by a test against the policy                           | the first docs page that states a price, plan limit or feature (it must never drift from `policy.ts`, ADR-0020)                      |
| Reference pages generated from code: API reference    | `z.toJSONSchema` / OpenAPI from `packages/contracts`, rendered with `starlight-openapi`; `starlight-typedoc` for SDKs                                                                                                                                         | the first public developer API (ADR-0002's trigger for a separate API Worker)                                                        |
| Shared UI or brand tokens package                     | `packages/brand` (CSS custom properties + assets) consumed by `apps/web` and `apps/docs`                                                                                                                                                                      | a second consumer of brand tokens (the docs theme alone isn't one)                                                                   |
| Versioning                                            | `starlight-versions`, or a branch per major deployed to its own hostname (Astro docs' model)                                                                                                                                                                  | the first breaking product change that leaves customers on an older version                                                          |
| i18n                                                  | Starlight locales beside the `root` English locale; Pagefind indexes per language                                                                                                                                                                             | a commitment to a non-English market                                                                                                 |
| Content negotiation (`Accept: text/markdown`)         | Cloudflare Markdown for Agents (Pro plan and up); or a Worker script                                                                                                                                                                                          | the zone moves to Pro, or agent traffic shows clients that never request `.md`                                                       |
| Access-gated internal docs site                       | below                                                                                                                                                                                                                                                         | below                                                                                                                                |
| Framework change                                      | Nimbus, Fumadocs                                                                                                                                                                                                                                              | Nimbus reaches 1.0, or Starlight stalls (no release for 6 months, or a new Astro major unsupported for 3 months)                     |

**Internal docs.** ADRs, runbooks and `AGENTS.md` stay Markdown in the repo, because every current reader (the owner, Claude Code, Codex) has repo access, and GitHub renders them. Revisit when someone needs them without repo access: a support person, a contractor, an auditor. The likely shape is a second Starlight site, or a second content collection, on its own Worker behind Cloudflare Access. That adds a product (Access) and possibly a service token for CI, so it needs its own ADR (invariant 14), with the same no-bindings rule.

## Consequences

- Two more Workers per product (`<product>-docs`, `<product>-docs-preview`), two per-Worker tokens and two `main`-only environments (`docs`, `docs-preview`). The owner creates the Workers and attaches the Custom Domain once.
- Docs get CI production deploys alongside the app's (ADR-0029), with a token scoped to a Worker with no bindings.
- `check-bindings.mjs` learns a second config, with stricter rules than `apps/web`'s (no bindings at all).
- Starlight is 0.x, so upgrades are deliberate PRs, not a grouped bump.
- Draft docs of open or closed PRs are public on `workers.dev` preview URLs.
- The follow-up PR updates the AGENTS.md module map and invariant 14's wording, the runbook ("Docs", "CI credentials"), `start-new-product.md` (Worker names, hostname, environments) and the architecture diagram.
