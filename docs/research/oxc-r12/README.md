# R12: Oxc tooling spike (Oxfmt, Oxlint)

Research archive for the 2026-10-21 spike that compared Oxfmt with Prettier and Oxlint with ESLint on this repository.

**Decision (owner, 2026-10-21):** adopt Oxfmt 0.74.0 in place of Prettier (ADR-0006 note); keep ESLint 10 and every boundary rule; defer Oxlint, research only.

| File                                       | What it holds                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| [`results.md`](results.md)                 | The spike report: versions, commands, timings, coverage, blockers, assumptions        |
| [`fixtures-matrix.md`](fixtures-matrix.md) | All 112 boundary fixtures under ESLint, the naive and safe hybrids, and native Oxlint |
| [`oxlint-resume.md`](oxlint-resume.md)     | Gaps found, approaches to try, the pass/fail contract and reopen criteria for Oxlint  |
| [`artifacts/`](artifacts/)                 | Scripts and configs from the disposable clone (below)                                 |

Artifacts (run from a disposable clone's root, never the main tree; paths in them are relative to it):

- `fixtures-matrix.mjs`: the parity runner that produced `fixtures-matrix.md`. Needs `eslint.orig.config.js` (the unchanged config), `eslint.naive.config.js` (the patch below pointing at the full migrated config), `eslint.config.js` with `eslint-safe-hybrid.patch`, `.oxlintrc.full.json` and `.oxlintrc.json`.
- `eslint-safe-hybrid.patch`: the two lines that load `eslint-plugin-oxlint`'s off-list into `eslint.config.js`.
- `oxlintrc.migrated.json`: `@oxlint/migrate` 1.89.0 output for `eslint.config.js`, unchanged. Its off-list switches off boundary rules; don't use it with the plugin.
- `oxlintrc.safe.json`: the migrated config without `no-restricted-imports` and `typescript/no-require-imports`.
- `spike-plugin.mjs`, `oxlintrc.js-plugin.json`: the one `no-restricted-syntax` selector ported to an Oxlint JS plugin.
- `oxfmtrc.migrated.json`: `oxfmt --migrate=prettier` output (the adopted config started from it).
- `pipelines.sh`, `time-runs.sh`: the timed pipelines and the timing helper.
- `migrate.log`: `@oxlint/migrate --details` output.
- `prettier-files.txt`: the 235 files Prettier formatted at `5fcfb12` (Oxfmt covered the same set).
