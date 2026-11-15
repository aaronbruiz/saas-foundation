import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'
import { getBillingFn, openBillingPortalFn, startCheckoutFn } from '../modules/billing/functions'
import { messageOf, useHydrated } from '../lib/ui'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FieldError } from '@/components/ui/field'

type Search = { checkout?: 'success'; portal?: 'return' }

// Plan, usage and the paid-plan actions (ADR-0020). What's shown and allowed comes from the server
// (policy + capability matrix); the page only renders it. The return markers from Polar only choose
// the page's wording: they're never read as a payment and grant nothing (invariant 6).
export const Route = createFileRoute('/t/$tenant/billing')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(search.checkout === 'success' ? { checkout: 'success' as const } : {}),
    ...(search.portal === 'return' ? { portal: 'return' as const } : {}),
  }),
  loader: ({ params }) => getBillingFn({ data: { tenant: params.tenant } }),
  component: Billing,
})

type Overview = Awaited<ReturnType<typeof getBillingFn>>

/**
 * After checkout, the overview is read again after each of these waits (about 30 s in all), until it
 * shows a live subscription (owner-approved, 2026-11-15). The last wait ending only ends the page's
 * waiting: it says nothing about the payment and changes no server state (ADR-0043's attempt and
 * gate stay the server's).
 */
const CHECKOUT_WAITS_MS = [2000, 3000, 5000, 8000, 12000]

type Return = 'checking' | 'applied' | 'delayed' | 'portal' | null

const limitText = (used: number, limit: number | null) =>
  limit === null ? `${used} (unlimited)` : `${used} of ${limit}`

function Billing() {
  const hydrated = useHydrated()
  const loaded = Route.useLoaderData()
  const search = Route.useSearch()
  const { tenant } = Route.useParams()
  const router = useRouter()
  const checkout = useServerFn(startCheckoutFn)
  const portal = useServerFn(openBillingPortalFn)
  const read = useServerFn(getBillingFn)
  const [error, setError] = useState<string | null>(null)
  // A read made by this page, used until the loader answers again.
  const [fresh, setFresh] = useState<{ base: Overview; data: Overview } | null>(null)
  const billing = fresh?.base === loaded ? fresh.data : loaded
  // Fixed when the page opens: removing the marker afterwards doesn't end the message.
  const [returned, setReturned] = useState<Return>(() =>
    search.checkout ? (loaded.live ? 'applied' : 'checking') : search.portal ? 'portal' : null,
  )
  const [readFailed, setReadFailed] = useState(false)
  const [checking, setChecking] = useState(false)
  // Set before the first await, and kept once the browser is leaving for Polar.
  const leaving = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)

  // Applied: drop the marker, so a reload or Back doesn't wait again.
  const applied = returned === 'applied'
  useEffect(() => {
    if (applied && search.checkout)
      void router.navigate({ to: '.', search: {}, replace: true, resetScroll: false })
  }, [applied, search.checkout, router])

  /** One read of the overview; true when it shows a live subscription, null when it failed. */
  async function readOnce(isCurrent: () => boolean): Promise<boolean | null> {
    try {
      const data = await read({ data: { tenant } })
      if (!isCurrent()) return null
      setFresh({ base: loaded, data })
      setReadFailed(false)
      return data.live
    } catch {
      if (isCurrent()) setReadFailed(true)
      return null
    }
  }

  // The automatic wait after checkout. Leaving the page cancels the next read; one in flight
  // finishes, and its answer is dropped.
  const waiting = returned === 'checking'
  useEffect(() => {
    if (!waiting) return
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const step = (i: number) => {
      timer = setTimeout(async () => {
        const live = await readOnce(() => current)
        if (!current) return
        if (live) return setReturned('applied')
        if (i + 1 < CHECKOUT_WAITS_MS.length) step(i + 1)
        else setReturned('delayed')
      }, CHECKOUT_WAITS_MS[i])
    }
    step(0)
    return () => {
      current = false
      clearTimeout(timer)
    }
    // Started once per checking phase; reads use the latest tenant through the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting])

  // "Check again": one read. It restarts nothing: not the wait, not a checkout.
  const mounted = useRef(true)
  useEffect(() => {
    // Set here too: StrictMode runs the cleanup once before mounting again.
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])
  async function checkAgain() {
    if (checking) return
    setChecking(true)
    const live = await readOnce(() => mounted.current)
    if (!mounted.current) return
    setChecking(false)
    if (live) setReturned('applied')
  }

  // Back from Polar can restore this page from the browser's cache: what it shows is from before,
  // so it reads once more, and the buttons that were leaving work again.
  useEffect(() => {
    function onPageShow(e: PageTransitionEvent) {
      if (!e.persisted) return
      leaving.current = false
      setBusy(null)
      if (returned) void checkAgain()
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  })

  async function go(key: string, action: () => Promise<{ url: string }>) {
    if (leaving.current) return
    leaving.current = true
    setBusy(key)
    setError(null)
    try {
      // Stays disabled while the browser leaves for Polar.
      window.location.assign((await action()).url)
    } catch (err) {
      leaving.current = false
      setBusy(null)
      setError(messageOf(err))
    }
  }

  const sub = billing.subscription
  const disabled = !hydrated || busy !== null || returned === 'checking'
  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">Billing</h2>
      <ReturnStatus
        returned={returned}
        plan={billing.plan.name}
        readFailed={readFailed}
        checking={checking}
        onCheckAgain={checkAgain}
        hydrated={hydrated}
      />
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
                  disabled={disabled}
                  aria-busy={busy === p.key || undefined}
                  onClick={() => go(p.key, () => checkout({ data: { tenant, price: p.key } }))}
                >
                  {busy === p.key
                    ? 'Opening Polar…'
                    : `Upgrade to ${p.planName} (${p.interval === 'year' ? 'yearly' : 'monthly'})`}
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
                disabled={disabled}
                aria-busy={busy === 'portal' || undefined}
                onClick={() => go('portal', () => portal({ data: { tenant } }))}
              >
                {busy === 'portal' ? 'Opening Polar…' : 'Manage billing'}
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

/**
 * What the page knows after a return from Polar, from the overview only. It never says a payment
 * failed: an unchanged plan can't tell a failed payment from a webhook that hasn't arrived.
 */
function ReturnStatus({
  returned,
  plan,
  readFailed,
  checking,
  onCheckAgain,
  hydrated,
}: {
  returned: Return
  plan: string
  readFailed: boolean
  checking: boolean
  onCheckAgain: () => void
  hydrated: boolean
}) {
  if (!returned) return null
  // Rendered from the page's first render after a return, so the region exists before its text
  // changes.
  const text =
    returned === 'checking'
      ? 'Checking for your new plan. This can take a moment.'
      : returned === 'applied'
        ? `Your plan is now ${plan}.`
        : returned === 'delayed'
          ? readFailed
            ? "We couldn't check for an update just now."
            : "Your new plan isn't showing yet. If you completed the payment, it will appear here once Polar confirms it: don't start another checkout. If it doesn't appear within a few minutes, contact support."
          : readFailed
            ? "We couldn't check for an update just now."
            : 'Changes you made in Polar can take a moment to show here.'
  const canCheck = returned === 'delayed' || returned === 'portal'
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border p-4">
      <p role="status" className="text-sm">
        {text}
      </p>
      {canCheck && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hydrated || checking}
          aria-busy={checking || undefined}
          onClick={onCheckAgain}
        >
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      )}
    </div>
  )
}
