import { applyBillingEvent, createDb, findOrganizationBySlug } from '@saas-foundation/db'
import { expect, test } from './fixtures'
import { createOrg } from './helpers'
import { sessionFile } from './session'

// ADR-0018, ADR-0022: the billing webhook route is wired and fails closed where billing isn't
// configured (local dev and every preview).
test('billing webhook refuses deliveries without a configured secret', async ({ request }) => {
  const res = await request.post('/api/billing/webhooks/polar', {
    headers: { 'webhook-id': 'msg_x', 'webhook-timestamp': '1', 'webhook-signature': 'v1,AAAA' },
    data: { type: 'subscription.updated', timestamp: '2026-01-01T00:00:00Z', data: {} },
  })
  expect(res.status()).toBe(503)
})

// The return from Polar (owner-approved behaviour, 2026-11-15): the marker only chooses the
// wording; the plan comes from the overview. Polar isn't configured locally, so the webhook's effect
// is written the way the webhook writes it (applyBillingEvent) into the dev database, which a
// preview's suite can't reach.
test.describe('returning from Polar', () => {
  test.use({ storageState: sessionFile })
  test.skip(!!process.env.BASE_URL, 'writes the subscription into the local dev database')

  test('after checkout the page checks, then shows the new plan once the webhook applied it', async ({
    page,
  }) => {
    await page.goto('/orgs/new')
    const slug = await createOrg(page, 'ret')
    await page.goto(`/t/${slug}/billing?checkout=success`)
    await expect(page.getByRole('status')).toHaveText(
      'Checking for your new plan. This can take a moment.',
    )
    await expect(page.getByTestId('plan-name')).toHaveText('Free')
    await expect(page.getByRole('button', { name: /^Upgrade to Pro \(monthly\)/ })).toBeDisabled()

    await applySubscription(slug)
    await expect(page.getByRole('status')).toHaveText('Your plan is now Pro.', { timeout: 20_000 })
    await expect(page.getByTestId('plan-name')).toHaveText('Pro')
    // The marker is gone, so a reload doesn't wait again.
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/billing$`))
    await page.reload()
    await expect(page.getByTestId('plan-name')).toHaveText('Pro')
    await expect(page.getByRole('status')).toHaveCount(0)
  })

  test('a loader refresh during the wait: the applied plan is the one shown', async ({ page }) => {
    await page.goto('/orgs/new')
    const slug = await createOrg(page, 'refresh')
    // The page's first background read is held before it reaches the server, so the order is
    // fixed: the loader refreshes (still Free), the plan changes, then the held read answers (Pro).
    let holding = true
    let held: () => void = () => {}
    const readHeld = new Promise<void>((resolve) => {
      void page.route('**/_serverFn/**', async (route) => {
        if (!holding || route.request().method() !== 'GET') return route.fallback()
        holding = false
        const release = new Promise<void>((r) => (held = r))
        resolve()
        await release
        await route.fallback()
      })
    })
    await page.goto(`/t/${slug}/billing?checkout=success`)
    await expect(page.getByRole('status')).toHaveText(/^Checking for your new plan/)
    await readHeld

    // The router's own refresh (`router.invalidate()`, which the app calls after its writes) on the
    // mounted page: new loader data (still Free), the same component. `sync` waits for the reload,
    // which otherwise runs in the background and could answer after the plan changed.
    await page.evaluate(() => {
      document.querySelector('h2')!.dataset.mounted = 'first'
      type Router = { invalidate(opts: { sync: boolean }): Promise<void> }
      return (window as unknown as { __TSR_ROUTER__: Router }).__TSR_ROUTER__.invalidate({
        sync: true,
      })
    })
    await expect(page.getByTestId('plan-name')).toHaveText('Free')
    await applySubscription(slug)
    held()

    await expect(page.getByRole('status')).toHaveText('Your plan is now Pro.')
    await expect(page.getByTestId('plan-name')).toHaveText('Pro')
    // Still the page that was waiting, not a new one that loaded Pro by itself.
    await expect(page.locator('h2[data-mounted="first"]')).toHaveCount(1)
  })

  test('when the plan is still unchanged after the wait, the page says so and never that it failed', async ({
    page,
  }) => {
    await page.goto('/orgs/new')
    const slug = await createOrg(page, 'slow')
    // The background reads fail, and the last one never answers: the page keeps what it loaded,
    // and its own deadline still ends the wait.
    let failing = true
    let reads = 0
    await page.route('**/_serverFn/**', (route) => {
      if (!failing || route.request().method() !== 'GET') return route.fallback()
      if (++reads < 5) return route.abort()
      // Stalled: answered only after the page has stopped waiting, and then ignored.
      return new Promise<void>((resolve) => setTimeout(resolve, 10_000)).then(() =>
        route.fallback(),
      )
    })
    await page.goto(`/t/${slug}/billing?checkout=success`)
    const status = page.getByRole('status')
    await expect(status).toHaveText('Checking for your new plan. This can take a moment.')
    await expect(status).toHaveText("We couldn't check for an update just now.", {
      timeout: 45_000,
    })
    expect(reads).toBe(5)
    await expect(page.getByTestId('plan-name')).toHaveText('Free')
    await expect(page.getByRole('button', { name: /^Upgrade to Pro \(monthly\)/ })).toBeEnabled()

    // Check again: one read; the plan is still unchanged.
    failing = false
    const again = page.getByRole('button', { name: 'Check again' })
    await again.click()
    await expect(status).toContainText("Your new plan isn't showing yet.")
    await expect(status).toContainText("don't start another checkout")
    await expect(page.getByText(/fail|declin/i)).toHaveCount(0)

    await applySubscription(slug)
    await again.click()
    await expect(status).toHaveText('Your plan is now Pro.')
    await expect(page.getByTestId('plan-name')).toHaveText('Pro')
  })

  test('leaving the page during the wait stops its reads', async ({ page }) => {
    await page.goto('/orgs/new')
    const slug = await createOrg(page, 'away')
    await page.goto(`/t/${slug}/billing?checkout=success`)
    await expect(page.getByRole('status')).toHaveText(/^Checking for your new plan/)
    await page.getByRole('link', { name: 'Projects' }).click()
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
    let reads = 0
    page.on('request', (r) => {
      if (r.url().includes('/_serverFn/')) reads++
    })
    // Longer than the first two waits (2 s, then 3 s).
    await page.waitForTimeout(6_000)
    expect(reads).toBe(0)
  })

  test('back from the portal, the page reads the plan and offers to check again', async ({
    page,
  }) => {
    await page.goto('/orgs/new')
    const slug = await createOrg(page, 'portal')
    await applySubscription(slug)
    await page.goto(`/t/${slug}/billing?portal=return`)
    const status = page.getByRole('status')
    await expect(status).toHaveText('Changes you made in Polar can take a moment to show here.')
    await expect(page.getByTestId('plan-name')).toHaveText('Pro')
    // One read: it finds the live plan, so the page shows it as applied and stops offering a check.
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(status).toHaveText('Your plan is now Pro.')
    await expect(page.getByRole('button', { name: 'Check again' })).toHaveCount(0)
  })
})

test.describe('leaving for Polar', () => {
  test.use({ storageState: sessionFile })

  test('a second click while the first request runs sends nothing', async ({ page }) => {
    await page.goto('/orgs/new')
    const slug = await createOrg(page, 'twice')
    let sent = 0
    let answer: () => void = () => {}
    await page.route('**/_serverFn/**', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      sent++
      await new Promise<void>((resolve) => (answer = resolve))
      await route.fallback()
    })
    await page.goto(`/t/${slug}/billing`)
    const upgrade = page.getByRole('button', { name: /^Upgrade to Pro \(monthly\)/ })
    await expect(upgrade).toBeEnabled()
    await upgrade.click()
    await expect(page.getByRole('button', { name: 'Opening Polar…' })).toBeDisabled()
    await page.getByRole('button', { name: /^Upgrade to Pro \(yearly\)/ }).click({ force: true })
    answer()
    // Billing isn't configured locally: the refusal is the form's, and the buttons work again.
    await expect(page.getByRole('alert')).toHaveText('Billing is not configured')
    await expect(upgrade).toBeEnabled()
    expect(sent).toBe(1)
  })
})

async function applySubscription(slug: string) {
  const { db, close } = await createDb('postgres://app:app@localhost:5432/app')
  try {
    const org = await findOrganizationBySlug(db, slug)
    if (!org) throw new Error(`no organization ${slug}`)
    const outcome = await applyBillingEvent(db, {
      provider: 'polar',
      eventId: `evt_${crypto.randomUUID()}`,
      type: 'subscription.active',
      createdAt: new Date(),
      subscription: {
        organizationId: org.id,
        providerCustomerId: `cus_${crypto.randomUUID()}`,
        providerSubscriptionId: `sub_${crypto.randomUUID()}`,
        providerPriceId: 'price_e2e',
        planKey: 'pro',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        cancelAtPeriodEnd: false,
      },
    })
    expect(outcome).toBe('applied')
  } finally {
    await close()
  }
}
