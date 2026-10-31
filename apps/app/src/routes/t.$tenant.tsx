import { createFileRoute, Link, Outlet, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type SyntheticEvent } from 'react'
import { getTenantFn, getViewerFn } from '../modules/organizations/functions'
import { authClient } from '../lib/auth-client'
import { ErrorText, messageOf } from '../lib/ui'

// Tenant layout (ADR-0010). The loader re-verifies membership; unknown or foreign tenants get
// the root not-found page (404). This is UX: every server function re-checks on its own.
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
      <header className="mb-8 flex items-center justify-between border-b pb-4">
        <div>
          <p className="text-sm text-gray-500">Organization</p>
          {/* The key closes the menu when the tenant changes. */}
          <OrganizationMenu key={tenant.slug} slug={tenant.slug} name={tenant.name} />
        </div>
        <nav className="flex gap-4 text-sm">
          <Link to="/t/$tenant/projects" params={{ tenant: tenant.slug }} className="underline">
            Projects
          </Link>
          <Link to="/t/$tenant/members" params={{ tenant: tenant.slug }} className="underline">
            Members
          </Link>
          {canInvite && (
            <Link to="/t/$tenant/invite" params={{ tenant: tenant.slug }} className="underline">
              Invite
            </Link>
          )}
          {canSeeBilling && (
            <Link to="/t/$tenant/billing" params={{ tenant: tenant.slug }} className="underline">
              Billing
            </Link>
          )}
          <Link to="/account" className="underline">
            Account
          </Link>
          <button type="button" onClick={signOut} className="underline">
            Sign out
          </button>
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
    <details onToggle={onToggle} className="relative">
      <summary className="cursor-pointer">
        <h1 className="inline text-xl font-semibold">{name}</h1>
      </summary>
      <div className="absolute z-10 mt-2 w-64 space-y-2 rounded border bg-white p-3 text-sm shadow">
        <ul className="space-y-2">
          {others.map((o) => (
            <li key={o.slug}>
              <Link to="/t/$tenant/projects" params={{ tenant: o.slug }} className="underline">
                {o.name}
              </Link>
            </li>
          ))}
          <li>
            <Link to="/orgs/new" className="underline">
              New organization
            </Link>
          </li>
        </ul>
        <ErrorText error={error} />
      </div>
    </details>
  )
}
