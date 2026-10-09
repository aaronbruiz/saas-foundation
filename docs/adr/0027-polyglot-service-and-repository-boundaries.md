# ADR-0027: Polyglot services and repository boundaries

Status: Accepted · Date: 2026-10-08

## Context

The product is one TypeScript Worker ([ADR-0002](0002-single-tanstack-start-worker.md)) and a pnpm workspace. A later workload may need another runtime (Go, Python, Rust, PHP, Ruby, …) or a deployment target other than Workers. ADR-0002 and [ADR-0007](0007-defer-cloudflare-products.md) set triggers for a second Worker and for Cloudflare products only; nothing covers another runtime, a container, or a non-Cloudflare platform.

Tenant isolation is enforced only in TypeScript: `getTenantContext` verifies membership and `packages/db` repositories filter by `ctx.orgId`. The database has no row-level security and no per-service roles, and the app and migrations share one owner credential. Any other process holding a database credential would bypass every tenancy guarantee.

## Decision

No structural change now: no `services/` directory, no language-neutral contracts directory, no task orchestrator, no CI change. The rules below apply when the first other deployable is proposed.

### Directory semantics

- `apps/<name>/` is a deployable unit in any runtime. It owns its native manifest (`package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, …), its build and its deploy config (wrangler config, Dockerfile, platform config).
- `packages/<name>/` is a library imported by other code. A library in another language goes here only once a second deployable consumes it.
- Library or service: a library runs inside its caller's process and deploys with it; a service has its own process, deployment, credentials and failure domain.
- pnpm governs JavaScript/TypeScript only. Other ecosystems use their own tools and lockfiles; pnpm doesn't wrap them.
- A separate `services/` root, or grouping by domain, is reconsidered when deployables become hard to find or ownership splits (heuristic: around five deployables or a second owning team). Grouping by language is not used.

### When something becomes a separate service

A new deployable needs its own ADR showing at least one of these, with evidence (a named library, a measurement, a failed run, a requirement), not a forecast:

1. **Runtime or ecosystem**: a required library or runtime has no adequate TypeScript/Workers equivalent.
2. **Execution limits**: the workload exceeds what the Worker can do (CPU, memory, duration, bundle size, native binaries, GPU), shown by measurement.
3. **Independent scaling**: its load profile differs enough from the web Worker that scaling them together is measurably costly or degrades the web path.
4. **Failure isolation**: its failure or resource exhaustion must not affect the web path, and it can't be contained inside the Worker (Queues, Workflows, `waitUntil`).
5. **Deployment lifecycle**: it must release on a cadence or with a rollout process the Worker can't share.
6. **Security or regulatory isolation**: untrusted code, a separate trust boundary, compliance or data residency.
7. **Ownership**: a separate team owns it end to end.

Not sufficient on their own: preference for a language, "cleaner architecture", hypothetical future scale, splitting by technical layer, or a component that would share the schema and deploy in lockstep with the Worker.

Before the first production deploy, the ADR and PR show:

- **Ownership**: a named owner and a runbook entry.
- **Platform**: chosen for the workload — runtime needs, execution limits, security, operational effort and cost. Cloudflare (Workers, Python Workers, Containers) is preferred where it fits; another platform is fine when the ADR says why.
- **Deployment**: a repeatable deploy path, and how previews stay isolated from production data ([ADR-0021](0021-per-pr-preview-data-behind-a-trusted-boundary.md)).
- **Security**: the tenant-data boundary below.
- **Testing**: its tests and deploy checks run in CI and protect merges to `main`; a skipped or failed job can't let a change through.
- **Observability**: structured logs with stable event names and no personal data ([ADR-0015](0015-observability-baseline.md)), a request id carried across the call, and a health check.
- **Maintenance**: a native, pinned toolchain and dependency updates for its ecosystem.

### Tenant data across runtimes

A new service gets **no database access by default**. Any service that stores, reads or receives tenant data enforces tenant isolation and authorization through a mechanism reviewed in its ADR and covered by cross-tenant tests. Receiving data from the Worker doesn't remove that duty: the service still has to keep one tenant's data from another's in its own storage, caches, logs and outputs.

Invariants, whatever the mechanism:

1. **Tenant context and caller identity**: each service authenticates or otherwise verifies the trusted origin of incoming requests or messages, validates the authorized tenant scope, and enforces the permissions that apply to its operations. Tenant identifiers supplied by untrusted callers are never authorization evidence; a transport (service binding, queue, token) is not by itself proof that an operation is authorized. The mechanism is documented and tested. Options include a service binding reachable only from the Worker, or a short-lived token with audience and expiry minted after `getTenantContext`.
2. **Authorization** has one source of truth. By default the Worker's capability matrix decides before the call; a service that authorizes on its own documents how its rules stay equivalent.
3. **Least privilege**: each service has its own credentials, scoped to what it needs. Never the Worker's database credential, the owner role, or a role that bypasses row-level security.
4. **Auditability**: actions on tenant data are attributable to service, request and tenant in logs, with the redaction rules of ADR-0015.
5. **Secrets** come only from the platform's environment or secret store ([invariant 8](../../AGENTS.md)).

Boundary options, in order of preference:

| Option                                                                                                                                                                                                      | Isolation                                               | Notes                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| Worker-mediated (default): the Worker authorizes, then calls the service (service binding/RPC, or a queue message) with only the data it needs                                                              | Tenancy stays in one code path                          | The service holds no tenant database credential |
| Service calls an internal Worker API with a scoped short-lived token                                                                                                                                        | Reuses repositories                                     | Needs a token format and verification           |
| Service-owned store                                                                                                                                                                                         | Isolated from tenant tables                             | The service's own isolation is reviewed         |
| Direct database access with a dedicated non-owner role, least-privilege grants, row-level security (`FORCE`, tenant set per transaction — Hyperdrive pools in transaction mode) and explicit tenant filters | Defense in depth around a second tenancy implementation | Only with its own ADR                           |

### Contracts

Zod in `packages/contracts` stays the source of truth. When a contract is first consumed by a non-TypeScript runtime, export it (JSON Schema via `z.toJSONSchema`, or OpenAPI), commit the generated file and fail CI when it drifts from the Zod source. Shapes that cross the boundary avoid runtime-specific types and non-portable transforms; dates travel as strings in a defined format (e.g. RFC 3339). Protocol Buffers or another interface-definition mechanism may be adopted when concrete interoperability, compatibility or performance requirements justify the tooling, recorded in the relevant ADR.

### Tooling and CI

Native tooling first. A shared toolchain manager, a task runner, change-based CI or reusable workflows are added when a measured problem (pinning drift, slow or flaky CI, duplicated workflows) appears, with the topology chosen then. A monorepo orchestrator follows [ADR-0006](0006-toolchain.md)'s trigger.

### Agent instructions

The root `AGENTS.md` stays canonical ([ADR-0008](0008-agents-md-canonical.md)). A deployable gets its own `AGENTS.md` only when its rules or commands differ from the root's; add a sibling `CLAUDE.md` containing `@AGENTS.md`, since Claude Code doesn't read `AGENTS.md` when a `CLAUDE.md` exists.

## Consequences

- No cost today; the first service's ADR has a checklist instead of a blank page.
- Application-level tenant data access stays mediated by the web Worker's authorization and repository boundaries. Existing administrative and migration access is outside this service-access rule. Any new independently deployed service needing direct tenant-table access goes through a separate architectural and security review (its own ADR).
- ADR-0002 and ADR-0007 still govern extra Workers and Cloudflare products; this ADR adds the criteria for other runtimes and platforms.

## Deferred

| Decision                                       | Trigger                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `services/` or domain grouping                 | deployables hard to find, or a second owning team                                 |
| Generated contract files + drift check         | first contract consumed by a non-TypeScript runtime                               |
| Row-level security, per-service database roles | first service granted direct access to tenant tables (own ADR)                    |
| Internal service token format                  | first service called outside a service binding                                    |
| Shared toolchain manager or task runner        | toolchain drift or onboarding pain across two or more runtimes                    |
| Change-based CI, reusable workflows            | measured CI time, or two or more deployables with the same build and deploy shape |
| Monorepo orchestrator                          | ADR-0006 trigger                                                                  |
