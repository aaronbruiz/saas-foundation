import { createFileRoute, Link, Outlet, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type SyntheticEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { getTenantFn, getViewerFn } from '../modules/organizations/functions'
import { authClient } from '../lib/auth-client'
import { messageOf } from '../lib/ui'
import { FieldError } from '@/components/ui/field'

// Tenant layout (ADR-0010). The loader re-verifies membership; unknown or foreign tenants get
// the root not-found page (404). This is UX: every server function re-checks on its own.
// App nav on the brand's --sidebar-* tokens; the current page's item is filled (aria-current from the router).
const navItem =
  'rounded-md px-3 py-1.5 font-medium hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-sidebar-ring'
// Page links and the account links are two groups, each wrapping on its own, so at 320 px no
// row mixes them.
const navGroup = 'flex flex-wrap gap-1 rounded-lg bg-sidebar p-1'
// A popover link on its own line: at least 24 px tall (WCAG 2.5.8), with Button's focus ring.
const menuLink =
  'inline-flex min-h-6 items-center rounded-sm text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
const navActive =
  'bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground'

export const Route = createFileRoute('/t/$tenant')({
  loader: ({ params }) => getTenantFn({ data: { tenant: params.tenant } }),
  component: TenantLayout,
})

function TenantLayout() {
  const tenant = Route.useLoaderData()
  const router = useRouter()
  const canInvite = tenant.capabilities.includes('member:invite')
  const canSeeBilling = tenant.capabilities.includes('billing:read')

  async function signOut() {
    await authClient.signOut()
    await router.invalidate()
    await router.navigate({ to: '/login', search: { redirect: '/' } })
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <div>
          <p className="text-sm text-muted-foreground">Organization</p>
          {/* The key closes the menu when the tenant changes. */}
          <OrganizationMenu key={tenant.slug} slug={tenant.slug} name={tenant.name} />
        </div>
        <nav className="flex flex-wrap gap-2 text-sm text-sidebar-foreground">
          <div className={navGroup}>
            <Link
              to="/t/$tenant/projects"
              params={{ tenant: tenant.slug }}
              className={navItem}
              activeProps={{ className: navActive }}
            >
              Projects
            </Link>
            <Link
              to="/t/$tenant/members"
              params={{ tenant: tenant.slug }}
              className={navItem}
              activeProps={{ className: navActive }}
            >
              Members
            </Link>
            {canInvite && (
              <Link
                to="/t/$tenant/invite"
                params={{ tenant: tenant.slug }}
                className={navItem}
                activeProps={{ className: navActive }}
              >
                Invite
              </Link>
            )}
            {canSeeBilling && (
              <Link
                to="/t/$tenant/billing"
                params={{ tenant: tenant.slug }}
                className={navItem}
                activeProps={{ className: navActive }}
              >
                Billing
              </Link>
            )}
            <Link
              to="/t/$tenant/settings"
              params={{ tenant: tenant.slug }}
              className={navItem}
              activeProps={{ className: navActive }}
            >
              Settings
            </Link>
          </div>
          <div className={navGroup}>
            <Link to="/account" className={navItem} activeProps={{ className: navActive }}>
              Account
            </Link>
            <button type="button" onClick={signOut} className={navItem}>
              Sign out
            </button>
          </div>
        </nav>
      </header>
      <Outlet />
    </div>
  )
}

/**
 * The user's other organizations, read when the menu opens: this layout's loader runs on every
 * navigation, and that path's added latency is an open observation (roadmap, M3).
 */
function OrganizationMenu({ slug, name }: { slug: string; name: string }) {
  const getViewer = useServerFn(getViewerFn)
  const [others, setOthers] = useState<{ slug: string; name: string }[]>([])
  const [error, setError] = useState<string | null>(null)

  async function onToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    if (!e.currentTarget.open) return
    setError(null)
    try {
      const viewer = await getViewer()
      setOthers((viewer?.organizations ?? []).filter((o) => o.slug !== slug))
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <details onToggle={onToggle} className="group relative">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
        <h1 className="inline text-xl font-semibold">{name}</h1>
        <ChevronDown
          aria-hidden="true"
          className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="absolute z-10 mt-2 w-64 space-y-2 rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow">
        <ul className="space-y-2">
          {others.map((o) => (
            <li key={o.slug}>
              <Link to="/t/$tenant/projects" params={{ tenant: o.slug }} className={menuLink}>
                {o.name}
              </Link>
            </li>
          ))}
          <li>
            <Link to="/orgs/new" className={menuLink}>
              New organization
            </Link>
          </li>
        </ul>
        <FieldError>{error}</FieldError>
      </div>
    </details>
  )
}
