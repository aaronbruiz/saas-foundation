// ADR-0033 decision 6: what the marketing site's pricing page may show, exported from the billing
// policy (modules/billing/policy.ts, ADR-0020) to apps/site/src/data/plans.json. The site imports
// the JSON, never app code. `--check` fails when the committed file differs from a fresh export
// (run by `pnpm check`), so the page can't drift from the policy. Amounts aren't here: they live
// in the provider (ADR-0022) and, for display, in apps/site/src/data/prices.json.
// Usage: node apps/app/scripts/export-plans.ts [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { format, resolveConfig } from 'prettier'
import { CHECKOUT, DEFAULT_PLAN, PLANS, purchasablePrices } from '../src/modules/billing/policy.ts'

const target = new URL('../../site/src/data/plans.json', import.meta.url)
const check = process.argv.includes('--check')
if (process.argv.length > 2 + Number(check)) {
  console.error('usage: export-plans.ts [--check]')
  process.exit(1)
}

const prices = purchasablePrices()
const exported = {
  $comment:
    'Generated from apps/app/src/modules/billing/policy.ts by `pnpm plans:export` (ADR-0033). Do not edit.',
  defaultPlan: DEFAULT_PLAN,
  trialDays: CHECKOUT.trialDays,
  plans: Object.entries(PLANS).map(([key, plan]) => ({
    key,
    name: plan.name,
    limits: plan.limits,
    features: plan.features,
    prices: prices.filter((p) => p.plan === key).map(({ key, interval }) => ({ key, interval })),
  })),
}

const path = target.pathname
const text = await format(JSON.stringify(exported), {
  ...(await resolveConfig(path)),
  filepath: path,
})
if (check) {
  let committed = ''
  try {
    committed = readFileSync(target, 'utf8')
  } catch {
    // missing counts as different
  }
  if (committed !== text) {
    console.error(
      '[plans] apps/site/src/data/plans.json differs from modules/billing/policy.ts: run `pnpm plans:export` and commit it',
    )
    process.exit(1)
  }
  console.log('[plans] apps/site/src/data/plans.json matches the billing policy')
} else {
  writeFileSync(target, text)
  console.log('[plans] wrote apps/site/src/data/plans.json')
}
