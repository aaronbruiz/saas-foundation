// The pricing page's data (ADR-0033 decision 6): plans, limits and trial from plans.json (exported
// from the app's billing policy and drift-checked by `pnpm check`), amounts from prices.json (kept
// equal to the provider by hand). Checked when this module loads, so `astro build` fails rather
// than publish a price that's missing, unknown or malformed.
import plansData from '../data/plans.json'
import pricesData from '../data/prices.json'

type Interval = 'month' | 'year'
type Limit = number | null

type ExportedPlan = {
  key: string
  name: string
  limits: { projects: Limit; members: Limit }
  features: string[]
  prices: { key: string; interval: string }[]
}

export type Price = { key: string; interval: Interval; amount: number; currency: string }
export type Plan = Omit<ExportedPlan, 'prices'> & { prices: Price[]; isDefault: boolean }

const isInterval = (v: string): v is Interval => v === 'month' || v === 'year'

function loadPlans(): Plan[] {
  const amounts: Record<string, unknown> = { ...pricesData }
  delete amounts.$comment
  const purchasable = new Set(plansData.plans.flatMap((p) => p.prices.map((price) => price.key)))
  for (const key of Object.keys(amounts))
    if (!purchasable.has(key))
      throw new Error(`prices.json: "${key}" isn't a purchasable price in plans.json`)

  if (!plansData.plans.some((p) => p.key === plansData.defaultPlan))
    throw new Error(`plans.json: the default plan "${plansData.defaultPlan}" is missing`)
  return (plansData.plans as ExportedPlan[]).map((plan) => {
    const isDefault = plan.key === plansData.defaultPlan
    // Only the default plan is free; a plan on sale has prices (export-plans.ts drops the rest).
    if (isDefault !== (plan.prices.length === 0))
      throw new Error(`plans.json: "${plan.key}" must be the default plan or have prices, not both`)
    return {
      ...plan,
      isDefault,
      prices: plan.prices.map(({ key, interval }) => {
        const entry = amounts[key] as { amount?: unknown; currency?: unknown } | undefined
        if (!entry) throw new Error(`prices.json: no amount for "${key}"`)
        const { amount, currency } = entry
        if (!Number.isInteger(amount) || (amount as number) <= 0)
          throw new Error(`prices.json: "${key}".amount must be a positive integer (minor units)`)
        if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
          throw new Error(`prices.json: "${key}".currency must be an ISO 4217 code`)
        if (!isInterval(interval))
          throw new Error(`plans.json: "${key}" has interval "${interval}"`)
        return { key, interval, amount: amount as number, currency }
      }),
    }
  })
}

export const plans = loadPlans()
export const trialDays: number = plansData.trialDays

/** An amount in minor units, e.g. 2900 USD → "$29". */
export function formatAmount({ amount, currency }: Pick<Price, 'amount' | 'currency'>) {
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency })
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2
  const value = amount / 10 ** digits
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : digits,
  }).format(value)
}

export const limitText = (limit: Limit, noun: string) =>
  limit === null ? `Unlimited ${noun}s` : `Up to ${limit} ${noun}${limit === 1 ? '' : 's'}`
