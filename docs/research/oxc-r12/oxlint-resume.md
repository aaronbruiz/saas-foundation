# Oxlint: preserved R12 findings and how to resume

**Status: deferred.** ESLint 10 stays the authoritative linter, with every boundary rule in `eslint.config.js`. Oxfmt replaced Prettier (ADR-0006 note, 2026-10-21). This note lets a later engineer or agent resume from the R12 evidence instead of repeating the spike. Evidence: [`results.md`](results.md), [`fixtures-matrix.md`](fixtures-matrix.md), [`artifacts/`](artifacts/).

## 1. Baseline of the experiment

- Run 2026-10-21 01:48–02:10Z on a disposable clone of `5fcfb12` (origin removed, outside the main repository). WSL2, 8 threads, Node 24.14.0, pnpm 12.11.2.
- Versions: ESLint **10.12.0**, Prettier **3.9.10**, Oxlint **1.89.0**, eslint-plugin-oxlint **1.89.0**, @oxlint/migrate **1.89.0**, Oxfmt **0.74.0**.
- Baseline: **112/112** fixtures in `node --test scripts/lint-boundaries.test.mjs`; ESLint linted 129 files with 0 errors.
- Native Oxlint ran in about 0.06 s on 133 files with no diagnostics. That speed is **not parity** (section 2).
- Full-check medians (n=3, warm, local): current P0 **32.13 s**, Oxfmt only P1 **27.09 s**, Oxfmt + safe hybrid P2 **26.88 s**. P2's 0.21 s gain over P1 is inside the run-to-run spread. Lint alone: safe hybrid 3.31 s vs ESLint 3.91 s. Cold CI timings weren't measured. Pipeline definitions: [`artifacts/pipelines.sh`](artifacts/pipelines.sh).

## 2. Confirmed gaps and dangerous behaviour

### A. The generated off-list disables boundary enforcement

`eslint-plugin-oxlint`'s `buildFromOxlintConfigFile`, fed the config from `@oxlint/migrate`, switched off 112 ESLint rules, among them **`no-restricted-imports`** (in all 11 config blocks) and **`@typescript-eslint/no-require-imports`**. With that naive hybrid **44 of 112 boundary fixtures failed** (column "naive hybrid" in [`fixtures-matrix.md`](fixtures-matrix.md)). Removing both rules from the Oxlint config by hand ([`artifacts/oxlintrc.safe.json`](artifacts/oxlintrc.safe.json), wired in by [`artifacts/eslint-safe-hybrid.patch`](artifacts/eslint-safe-hybrid.patch)) made the hybrid pass **112/112**, and it still caught three hand-made violations (a route importing `drizzle-orm`, `sql.raw(s)` in a module service, `require('pg')` in `lib/`). Re-running the migration regenerates the dangerous off-list.

### B. Native import restrictions silently miss patterns

Native Oxlint with the migrated config ([`artifacts/oxlintrc.migrated.json`](artifacts/oxlintrc.migrated.json)), on the 44 import/require violation fixtures: **33 match, 10 miss, 1 fires with Oxlint's own message** (`require`). All 20 allowed cases stay clean. Silently accepted examples: `../billing/service`, `../organizations/service`, `../server/./db`, `export * from '../billing/service'`. Oxlint raised no config error or warning. The missed patterns (module boundary, normalized paths) contain negative lookahead `(?!…)`; a regex engine without look-around is **a hypothesis, not a verified cause**. Some fixtures in the same pattern still match through other alternatives, so don't judge parity by counts alone.

### C. `no-restricted-syntax` isn't native in 1.89.0

`@oxlint/migrate` reported it "Not Implemented"; **45 of 48** selector-based fixtures didn't fire under native Oxlint (the 3 that did are literal `import()` calls, which Oxlint's `no-restricted-imports` also checks: fixtures 6, 61, 84). The ESLint selectors cover `sql.raw` and `sql` aliases, SQL text built at runtime, split literals, the tenant-context setters (`set_config`, `SET/RESET app.*`), `$client` and `pg` access, non-literal `import()`, `import.meta.glob`, and type-level `import()` module boundaries (14 selectors in `eslint.config.js`). A few narrow native rules don't make this a replacement.

### D. Other rules the migration skipped

`no-undef`, `no-useless-assignment` (nursery), `no-dupe-args`, `no-octal` (unsupported: "superseded by strict mode"). React Hooks rules were mapped to native `react/rules-of-hooks` and `react/exhaustive-deps`; their behaviour wasn't compared. Log: [`artifacts/migrate.log`](artifacts/migrate.log).

## 3. Approaches to test when resuming (not proven here)

**A. Rewrite the import patterns without lookahead.** Express the same allowlists with patterns Oxlint supports: gitignore-style `group` lists with negation (for example `['../billing/*', '!../billing/entitlements', '!../billing/policy']`) or regexes without look-around. Verify path resolution, the order of exclusions, file globs, relative and aliased imports, and every positive and negative fixture. Glob negation isn't regex lookahead; don't assume they behave alike.

**B. A JS plugin for the selector rules.** Oxlint JS plugins use ESLint's rule API (visitors and selectors). R12 ported one selector verbatim ([`artifacts/spike-plugin.mjs`](artifacts/spike-plugin.mjs), config [`artifacts/oxlintrc.js-plugin.json`](artifacts/oxlintrc.js-plugin.json)): it fired on `sql.raw(s)` and `sql['raw'](s)` and not on `sql.join(...)`. A generic rule mapping selector/message pairs could carry all 14, but every selector, file override, AST difference (`TSImportType`, `TemplateElement` values) and message needs a parity test. The JS plugin API was alpha (not semver) in October 2026; check its status first.

**C. An Oxlint fixture runner.** `scripts/lint-boundaries.test.mjs` calls ESLint's API and stays ESLint's gate. Add an Oxlint-backed runner over the same cases; [`artifacts/fixtures-matrix.mjs`](artifacts/fixtures-matrix.mjs) is the starting point (it writes each fixture at its path, runs `oxlint --format json`, restores the file). It must assert that the **intended rule** reported the expected message, not that any diagnostic appeared.

**Narrow native option: `no-restricted-properties`.** May cover simple member access (`sql.raw`, a named `$client` property). It doesn't cover arbitrary selectors, SQL text, non-literal imports, file-specific exceptions or aliasing. Untested in R12; test computed and aliased access separately.

## 4. Pass/fail contract for an Oxlint-only experiment

1. Disposable branch or clone, never the main working tree. Exact versions pinned and recorded with the source commit.
2. Inventory every ESLint rule and every invariant in `AGENTS.md` and `eslint.config.js`, not only R12's misses. Map each rule to native Oxlint, a JS plugin rule, or an accepted alternative.
3. Port import restrictions (A) and selector restrictions (B, plus `no-restricted-properties` where it's exact). Keep each file block's scope exact.
4. Build the Oxlint fixture runner (C). Require **100 % parity without ESLint**: every current fixture (112 at R12; use the count in the checkout) plus new bypass attempts (normalized paths, module imports, `require`, `sql.raw`, `set_config`, `pg`/`$client`, non-literal `import()`, `import.meta.glob`).
5. Guard against silent disablement: each fixture asserts the named rule and message; unsupported config syntax must fail, not pass.
6. Re-run the whole pipeline, tests, build and e2e, on a clean checkout and in CI when available. Compare against a same-machine Oxfmt + ESLint baseline, warm and (if possible) cold.
7. Test at least one Oxlint upgrade: a plugin API change could weaken enforcement without an obvious failure.
8. Fail closed: keep ESLint if any fixture fails, a required diagnostic disappears, plugin API churn is unacceptable, or the full workflow gains nothing meaningful.
9. Don't adopt the safe hybrid as the default direction: it adds config drift for no measured total-check gain.

## 5. When to reopen

Reopen only if at least one holds, and then require both a measured gain and invariant parity:

- lint or `pnpm check` time becomes a measured bottleneck (ADR-0006), for example after type-aware rules or more architectural checks;
- the Oxlint JS plugin API becomes stable, or import-pattern handling gains parity or reports unsupported patterns as errors;
- a new rule set brings significant value with clearly less overhead;
- a changed CI cost model makes the gain worth it.

Technical feasibility alone isn't a reason.

## 6. Open hypotheses and sources

Unverified:

- Lookahead as the cause of the import-pattern misses (inferred, not traced in Oxlint's source).
- Whether all 14 selectors carry over unchanged to a JS plugin (one was tested).
- Whether upgrades keep selector behaviour, diagnostics, file scoping and ignores stable.
- Whether a complete Oxlint-only setup measurably shortens `pnpm check`, which typecheck dominates.

Sources to re-read at the version you test:

- https://oxc.rs/docs/guide/usage/linter/writing-js-plugins.html
- https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-properties.html
- https://oxc.rs/docs/guide/usage/linter/rules
- https://github.com/oxc-project/oxlint-migrate
- Oxc discussion 11649 (comment 17682305) on GitHub, about JS plugin performance.
- Nicolas Charpentier, "Migrating from ESLint, Biome, and Prettier to Oxlint and Oxfmt" (2026-05-13): about 81 s → 2.5 s, mostly from replacing an expensive import resolver with a JS plugin, in a different repository. Not evidence for this one. The author later attributed a reported slowdown to a React Compiler plugin, not to the number of plugins.

**Start at A + B + C; don't re-run `@oxlint/migrate` naively.**
