# ADR-0034: OpenAPI generation for the public API: `@hono/zod-openapi` from `packages/contracts`

Status: Accepted (owner 2026-10-14) · Date: 2026-10-14

Decides in advance how the public developer API's OpenAPI document is produced, so the API Worker's own ADR doesn't reopen it. Nothing is built until that API's trigger fires ([ADR-0002](0002-single-tanstack-start-worker.md), [ADR-0007](0007-defer-cloudflare-products.md): a public developer API → a separate Worker, Hono allowed). Settles the generator left open by [ADR-0028](0028-public-docs-site.md)'s Deferred row "Reference pages generated from code: API reference" and applies [ADR-0027](0027-polyglot-service-and-repository-boundaries.md)'s "Contracts" rule to an HTTP API.

## Context

**Today:** no Hono app, no public API, no OpenAPI or JSON Schema export (`hono` appears in the lockfile only as a dependency of the `neon` CLI). Zod 4 schemas in `packages/contracts` are the source of truth for every input (invariant 9). They use `strictObject`, `.trim()`, `.refine` and `.default`.

**Requirements**, from the ADRs above and AGENTS.md:

1. The spec comes from the Zod contracts, never a second schema language or a hand-written copy (ADR-0027).
2. It can't drift from the routes: an operation can't exist without its spec entry, or the reverse.
3. Workers only (workerd), small bundle, no Node-only runtime code.
4. A generated file is committed and CI fails when it drifts (ADR-0027). It is rendered by `starlight-openapi`, which reads OpenAPI 3.0 and 3.1 (ADR-0028).
5. Tenant rules hold: validation must not reveal whether another tenant exists (invariant 5), and unknown keys such as `organizationId` are rejected.

**Options** (npm versions and repositories checked 2026-10-14; proof of concept below):

| Option                                                                                                             | For                                                                                                                                                 | Against                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@hono/zod-openapi`** (Hono org, 1.6.3; built on `@asteasolutions/zod-to-openapi`)                               | Each route definition produces the spec entry, request validation and a **compile-time check of the response shape**; typed `hc` client; 3.0 or 3.1 | `OpenAPIHono` class and `createRoute` per route; Zod only; type-check cost grows with chained routes (open issue, honojs/middleware 1918); no runtime response validation   |
| `hono-openapi` (rhinobase, 1.3.5)                                                                                  | Middleware on plain Hono; Standard Schema (Zod, Valibot, ArkType…); least code                                                                      | One maintainer; response shapes not type-checked unless wrapped; 3.1 only; its `standard-openapi` dependency conflicts with `zod-openapi` 6                                 |
| Chanfana (Cloudflare, 3.4.0)                                                                                       | Built for Workers; can extend an existing Hono app                                                                                                  | Class-based endpoints lose `hc` types; pins zod-to-openapi ^8; crashed merging a sub-router with named components (reproduced); largest bundle                              |
| Plain Hono + `@hono/zod-validator`, with `zod-openapi` (samchungy) or `z.toJSONSchema` and a hand-kept `paths` map | Smallest bundle (`z.toJSONSchema`: 0 at runtime); no framework coupling                                                                             | The `paths` map is written by hand, so a new route can ship undocumented: requirement 2 needs a separate route/spec agreement test                                          |
| Contract-first: oRPC, TypeSpec, ts-rest, Effect HttpApi                                                            | oRPC also has adapters for TanStack Start                                                                                                           | oRPC replaces Hono's routing and client, and its 2.0 is in beta; TypeSpec and Effect add a second schema language (requirement 1); ts-rest has had no release since 2025-06 |
| Static analysis (`@rcmade/hono-docs`, next-openapi-gen)                                                            | No runtime part                                                                                                                                     | Single maintainers; Zod 3-era converter or JSDoc, not the runtime contracts                                                                                                 |

Documentation viewers (Swagger UI, Scalar, Redoc, `starlight-openapi`), client generators (openapi-typescript, Hey API, Orval) and lint/diff tools (Redocly CLI, Spectral, oasdiff) are complements, not generators.

**Proof of concept** (scratch, 2026-10-14; Hono 4.13.11, Zod 4.6.5, TypeScript 6.0.3, wrangler 4.147.0). Each candidate implemented the same slice with the real contracts, copied unchanged: list, create, get and patch tenant projects, bearer auth, a mounted sub-app, one route without a schema, and a shared `Error` component.

- All candidates emitted OpenAPI 3.1.0 that keeps:
  - the mounted prefix and `{id}`;
  - `TenantSlug`'s pattern and 2–48 length, and the uuid format;
  - `additionalProperties: false` from `strictObject`, plus optional and required fields;
  - the query's 1–100 range and default 20;
  - the bearer scheme and `$ref` components.
- Regenerating gave byte-identical files.
- In workerd (`wrangler dev`), the four leading candidates:
  - served the spec;
  - rejected an unknown `organizationId` key with 400;
  - trimmed input.
- Every candidate bundled without `nodejs_compat`. Added gzip size over plain Hono + `@hono/zod-validator`:
  - `@hono/zod-openapi` +15.1 KiB;
  - `hono-openapi` +22.4 KiB;
  - Chanfana +42.1 KiB;
  - `zod-openapi` +7.8 KiB;
  - `z.toJSONSchema` +0.7 KiB.
- With auth, then tenant membership, then body validation, a non-member sending an invalid body gets 404, not 400.
- Returning the wrong response shape fails `tsc` only with `@hono/zod-openapi`.
- **Limits common to all:**
  - `.refine` (a PATCH must change something) and the `.trim()` normalisation don't appear in the spec;
  - routes without a schema are silently left out of it.
- `@hono/zod-openapi`'s `openAPIRegistry.register()` needs the global `extendZodWithOpenApi(z)` imported before the contracts. Zod 4's `.meta({ id })` names a component without it.

## Decision

Applies when the public developer API is built (its Worker gets its own ADR, invariant 14).

1. **Generator: `@hono/zod-openapi`** in the API Worker. Every public operation is an `OpenAPIHono` route defined with `createRoute`. Plain `app.get(...)` routes are only for non-API endpoints such as health.
2. **Schemas come from `packages/contracts`**, unchanged in substance. Components are named with Zod 4 `.meta({ id, description })` on the contract, never with `extendZodWithOpenApi` (a global mutation that depends on import order). Response schemas, such as resources and the error body, are added to `packages/contracts` too. Dates travel as RFC 3339 strings (ADR-0027).
3. **OpenAPI 3.1**, exported at build time by a script that imports the app and calls `getOpenAPI31Document` (no server, no network). The file is committed next to the API Worker.
4. **CI:**
   - regenerate and fail on any difference;
   - lint the file (Redocly CLI);
   - compare with the file on `main` using `oasdiff breaking --fail-on ERR` (skipped while `main` has no file yet, i.e. in the PR that adds it). A PR whose Conventional Commit title carries `!` skips only this comparison, as for migrations ([ADR-0029](0029-releases-deploys-and-rollback.md) decision 7). The drift and lint checks always run.
5. **Coverage test:** a test fails unless the set of method and path pairs registered under the public prefix equals the set of operations in the spec (both normalised to the `{param}` form). The only exclusions are non-API endpoints such as health, listed in the test. This catches both an undocumented route and a spec entry without a route.
6. **Rules the spec can't express** (refinements, normalisation such as trimming) go in each schema's `description`.
7. **Rendering:** `apps/docs` renders the committed file with `starlight-openapi` (ADR-0028). The spec is not served by the API Worker unless its ADR decides so.
8. **ADR-0027's schema-only exports** for non-TypeScript consumers keep using Zod's built-in `z.toJSONSchema`. This ADR covers only the HTTP API's document.
9. **Fallback:** `hono-openapi` replaces `@hono/zod-openapi` if the pilot's type-check time becomes unacceptable (measured at the first endpoint and again at about 30). Its schemas are the same contracts, so only the route definitions change.

## Consequences

- One definition per operation drives the spec, request validation and response types. Drift becomes a compile or CI failure instead of a review finding.
- The API Worker depends on `@hono/zod-openapi` and, through it, `@asteasolutions/zod-to-openapi`. Both follow Zod's major version, so a Zod major is upgraded together with them.
- Route definitions are longer than plain Hono handlers: about 6.5 lines per route against 3.8 in the proof of concept.
- Responses are checked by types, not at runtime. Contract tests in the API Worker's suite parse real responses with the contract schemas.
- Open until the pilot:
  - type-check cost at scale;
  - Hono 5, currently a release candidate (re-check `@hono/zod-openapi`'s peer range before upgrading);
  - `starlight-openapi` rendering of the generated file;
  - how API clients authenticate (decided in the API Worker's ADR).

## Rollout (when the trigger fires)

1. The API Worker's ADR: trigger, Hono Worker reached through a service binding, previews, API authentication, `/v1` versioning. It cites this ADR.
2. Contracts: `.meta` ids and response schemas for the resources the API exposes.
3. Pilot: one read endpoint with cross-tenant (404), auth (401) and validation (400) tests; record `tsc` time.
4. Export script, committed spec, and the CI checks in decision 4. Acceptance: an intentional schema change fails CI until the file is regenerated.
5. `starlight-openapi` reference pages in `apps/docs`.
6. The remaining endpoints, one module per PR, each with cross-tenant tests and the coverage test from decision 5.
