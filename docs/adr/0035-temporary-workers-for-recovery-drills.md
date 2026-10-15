# ADR-0035: Temporary Workers and Hyperdrive configs for recovery drills

Status: Proposed · Date: 2026-10-15

## Context

AGENTS.md invariant 14 and [ADR-0007](0007-defer-cloudflare-products.md) require an ADR naming the trigger for any additional Worker or Cloudflare product. The owner decided on 2026-10-15 that short-lived Workers created only to rehearse recovery are no exception, and that a lightweight ADR covering purpose, isolation, lifetime and cleanup may authorize them.

Two recovery drills need such resources. Both are designed in the recovery-readiness research (R02, kept outside the repository):

- **Secret-revert drill (D1b).** [ADR-0029](0029-releases-deploys-and-rollback.md) left as "to verify" whether `wrangler rollback` to a version from before a `wrangler secret put` restores the old secret value, and auto-confirms that in CI. It can't be tested on the production Worker without changing a production secret.
- **"Neon lost" rebuild drill (D5).** The database runbook's rebuild (new Neon project → restore a dump → point a Hyperdrive config at it) has only been rehearsed up to the local restore (2026-09-30). The pilot's recovery target (RTO ≤ 1 h for losing the Neon project or account) needs the Hyperdrive and Worker part timed too.

Alternatives considered:

- **Use the production Worker's Previews.** Each PR's Preview binds its own Hyperdrive config `saas-pr-N` and Neon branch, created and deleted only by default-branch jobs in `main`-only environments ([ADR-0021](0021-per-pr-preview-data-behind-a-trusted-boundary.md)). A drill there would run inside that trusted CI boundary or next to a preview credential, and couldn't repoint or delete its own Hyperdrive config. Rejected.
- **Don't drill.** Leaves ADR-0029's open item and the rebuild time unproven before real pilot data ([ADR-0032](0032-lift-the-data-gate-allowlisted-pilot.md)). Rejected.

## Decision

Temporary Workers and Hyperdrive configs may be created for recovery drills under these rules. A drill that can't meet them needs its own ADR.

1. **Purpose.** Only to rehearse a recovery path: the secret-revert drill (D1b) and the "Neon lost" rebuild drill (D5). Any other purpose needs another lightweight ADR covering the same four points.
2. **Isolation.**
   - **Names** are unique per execution: `r02-<drill>-<UTC timestamp>-<random>`. A drill never reuses or touches a resource it didn't create. It deploys only after a lookup of that name fails with Cloudflare's not-found error.
   - **Reach:** `workers.dev` only. No routes or custom domains, no `vars` or `env`. `preview_urls` is `false` and no Preview is ever created, so the config has no `previews` block.
   - **Bindings:** D1b has none and uses synthetic secret values. D5 has exactly one: a Hyperdrive config created by the same execution, pointing at a throwaway Neon project. It never uses a production or preview Hyperdrive config, the production database, or a preview Neon branch.
   - **Config:** the drill's Wrangler config is generated outside the repository and passed explicitly. Wrangler runs from outside the repository, so it can't discover or write `apps/*/wrangler.jsonc`, and creates resources with `--update-config=false`. Nothing is added to any tracked Wrangler config, so `scripts/check-bindings.mjs` is unaffected.
   - **Credentials:** the owner's own Wrangler and Neon logins. The drill unsets every inherited Cloudflare credential and `NEON_API_KEY`, so neither tool can use another key. D5's optional Hyperdrive-restart API token is the owner's own, passed only to that request. No CI job, CI token or GitHub environment is involved.
   - **Data:** D5 restores a production dump. It runs only while production holds no real customer data, before ADR-0032 step 6. Restoring real customer data into a drill project needs a new decision.
3. **Lifetime.** A resource exists only while its drill runs (expected under 1 hour) and never past the same UTC day.
4. **Cleanup.**
   - **Automatic:** on exit the drill deletes the Worker, Hyperdrive config and Neon project it created, tracked by id. If a resource may exist but its id is unknown, the drill prints its exact name and the lookup command.
   - **Owner check:** after every drill, `wrangler hyperdrive list` and `neon projects list` show no `r02-` resource, and `wrangler deployments status --name <name>` reports not found. Any leftover is deleted by hand the same day.
5. **Approval.** Every drill run is approved by the owner beforehand, with its exact commands.

## Consequences

- Invariant 14 is met by this ADR, with one stated exception: D5's Hyperdrive binding has no `previews` override. The override exists so a Preview never inherits a production storage binding. A drill Worker creates no Preview, and its only binding is its own throwaway config. AGENTS.md invariant 14 names this exception.
- ADR-0007's deferral table, `apps/app/wrangler.jsonc` and CI don't change.
- While a drill runs, its Worker is publicly reachable on `workers.dev`:
  - D1b returns a synthetic secret value.
  - D5 returns the database name, a backend process id and two row counts (organizations, applied migrations), never row contents.
- A drill Worker left behind after a failed cleanup stays reachable until deleted; the owner's same-day check covers it.
- ADR-0029's open item on secret revert is closed only when D1b has run and its result is recorded there.

## Notes (2026-10-15)

D1b and D5 ran on 2026-10-15 with owner approval, each with names unique to the run. Each deleted its Worker, Hyperdrive config and Neon project on exit. Afterwards `wrangler deployments status` returned not found (10007), `wrangler hyperdrive list` showed no `r02-` config and the Neon organization listed no `r02-` project. D1b's result is recorded in ADR-0029 (Notes 2026-10-15); D5's in the runbook ("Database", step 5).
