import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { getBillingFn, openBillingPortalFn, startCheckoutFn } from '../modules/billing/functions'
import { messageOf, useHydrated } from '../lib/ui'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FieldError } from '@/components/ui/field'

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
    <section className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">Billing</h2>
      <Card>
        <CardContent>
          <p className="text-base">
            Plan: <strong data-testid="plan-name">{billing.plan.name}</strong>
            {sub && ` (${sub.status.replace('_', ' ')})`}
          </p>
          {sub?.currentPeriodEnd && (
            <p className="text-muted-foreground">
              {sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} on{' '}
              {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </p>
          )}
          <ul className="flex flex-col gap-1">
            <li>Projects: {limitText(billing.usage.projects, billing.limits.projects)}</li>
            <li>Members: {limitText(billing.usage.members, billing.limits.members)}</li>
          </ul>
        </CardContent>
      </Card>
      {billing.canManage ? (
        <div className="flex flex-col gap-3">
          {billing.prices.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {billing.prices.map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  disabled={!hydrated}
                  onClick={() => go(() => checkout({ data: { tenant, price: p.key } }))}
                >
                  Upgrade to {p.planName} ({p.interval === 'year' ? 'yearly' : 'monthly'})
                </Button>
              ))}
            </div>
          )}
          {billing.prices.length > 0 && billing.trialDays > 0 && (
            <p className="text-sm text-muted-foreground">
              Includes a {billing.trialDays}-day free trial.
            </p>
          )}
          {billing.hasPortal && (
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={!hydrated}
                onClick={() => go(() => portal({ data: { tenant } }))}
              >
                Manage billing
              </Button>
            </div>
          )}
          <FieldError>{error}</FieldError>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the organization owner can change the plan.
        </p>
      )}
    </section>
  )
}
