# R12 pipelines, timed with time-runs.sh from the spike clone root (after `source pipelines.sh`).
# P0 = current pnpm check, P1 = Oxfmt only, P2 = Oxfmt + safe hybrid; L0/L2 = lint only.
# eslint.orig.config.js was the unchanged eslint.config.js; eslint.config.js carried eslint-safe-hybrid.patch.
P0="node_modules/.bin/eslint -c eslint.orig.config.js --ignore-pattern eslint.orig.config.js . && node --test scripts/lint-boundaries.test.mjs scripts/check-secrets.test.mjs scripts/check-migrations.test.mjs scripts/compare-catalogs.test.mjs && node_modules/.bin/prettier --check . && pnpm typecheck && pnpm plans:check && pnpm --filter app types:check"
P1="node_modules/.bin/eslint -c eslint.orig.config.js --ignore-pattern eslint.orig.config.js . && node --test scripts/lint-boundaries.test.mjs scripts/check-secrets.test.mjs scripts/check-migrations.test.mjs scripts/compare-catalogs.test.mjs && node_modules/.bin/oxfmt --check && pnpm typecheck && pnpm plans:check && pnpm --filter app types:check"
P2="node_modules/.bin/oxlint && node_modules/.bin/eslint --ignore-pattern eslint.orig.config.js . && node --test scripts/lint-boundaries.test.mjs scripts/check-secrets.test.mjs scripts/check-migrations.test.mjs scripts/compare-catalogs.test.mjs && node_modules/.bin/oxfmt --check && pnpm typecheck && pnpm plans:check && pnpm --filter app types:check"
L0="node_modules/.bin/eslint -c eslint.orig.config.js --ignore-pattern eslint.orig.config.js ."
L2="node_modules/.bin/oxlint && node_modules/.bin/eslint --ignore-pattern eslint.orig.config.js ."
