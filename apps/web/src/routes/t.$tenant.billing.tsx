import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { getBillingFn, openBillingPortalFn, startCheckoutFn } from '../modules/billing/functions'
import { ErrorText, buttonClass, messageOf, useHydrated } from '../lib/ui'

// Plan, usage and the paid-plan actions (ADR-0020). What's shown and allowed comes from the server
// (policy + capability matrix); the page only renders it.
export const Route = createFileRoute('/t/$tenant/billing')({
  loader: ({ params }) => getBillingFn({ data: { tenant: params.tenant } }),
  component: Billing,
})

const limitText = (used: number, limit: number | null) =>
  limit === null ? `${used} (unlimited)` : `${used} of ${limit}`

function Billing() {
  const hydrated = useHydrated()
  const billing = Route.useLoaderData()
  const { tenant } = Route.useParams()
  const checkout = useServerFn(startCheckoutFn)
  const portal = useServerFn(openBillingPortalFn)
  const [error, setError] = useState<string | null>(null)

  async function go(action: () => Promise<{ url: string }>) {
    try {
      window.location.assign((await action()).url)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const sub = billing.subscription
  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold">Billing</h2>
      <div className="rounded border bg-white p-4">
        <p>
          Plan: <strong data-testid="plan-name">{billing.plan.name}</strong>
          {sub && ` (${sub.status.replace('_', ' ')})`}
        </p>
        {sub?.currentPeriodEnd && (
          <p className="text-sm text-gray-600">
            {sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} on{' '}
            {new Date(sub.currentPeriodEnd).toLocaleDateString()}
          </p>
        )}
        <ul className="mt-3 text-sm">
          <li>Projects: {limitText(billing.usage.projects, billing.limits.projects)}</li>
          <li>Members: {limitText(billing.usage.members, billing.limits.members)}</li>
        </ul>
      </div>
      {billing.canManage ? (
        <div className="space-y-3">
          {billing.prices.map((p) => (
            <button
              key={p.key}
              type="button"
              disabled={!hydrated}
              className={`${buttonClass} mr-3`}
              onClick={() => go(() => checkout({ data: { tenant, price: p.key } }))}
            >
              Upgrade to {p.planName} ({p.interval === 'year' ? 'yearly' : 'monthly'})
            </button>
          ))}
          {billing.prices.length > 0 && billing.trialDays > 0 && (
            <p className="text-sm text-gray-600">Includes a {billing.trialDays}-day free trial.</p>
          )}
          {billing.hasPortal && (
            <button
              type="button"
              disabled={!hydrated}
              className={buttonClass}
              onClick={() => go(() => portal({ data: { tenant } }))}
            >
              Manage billing
            </button>
          )}
          <ErrorText error={error} />
        </div>
      ) : (
        <p className="text-sm text-gray-600">Only the organization owner can change the plan.</p>
      )}
    </section>
  )
}
