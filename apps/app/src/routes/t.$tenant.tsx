import { createFileRoute, Link, Outlet, useRouter } from '@tanstack/react-router'
import { getTenantFn } from '../modules/organizations/functions'
import { authClient } from '../lib/auth-client'

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
          <h1 className="text-xl font-semibold">{tenant.name}</h1>
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
          <button type="button" onClick={signOut} className="underline">
            Sign out
          </button>
        </nav>
      </header>
      <Outlet />
    </div>
  )
}
