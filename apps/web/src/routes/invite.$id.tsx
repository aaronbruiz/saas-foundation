import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { acceptInvitationFn, getViewerFn } from '../modules/organizations/functions'
import { ErrorText, buttonClass, messageOf, useHydrated } from '../lib/ui'

// The link returned by inviteMember. Sign-in (or sign-up) first, then accept explicitly.
export const Route = createFileRoute('/invite/$id')({
  loader: async ({ params }) => {
    const viewer = await getViewerFn()
    if (!viewer) throw redirect({ to: '/login', search: { redirect: `/invite/${params.id}` } })
    return { email: viewer.email }
  },
  component: AcceptInvitation,
})

function AcceptInvitation() {
  const hydrated = useHydrated()
  const { id } = Route.useParams()
  const { email } = Route.useLoaderData()
  const router = useRouter()
  const accept = useServerFn(acceptInvitationFn)
  const [error, setError] = useState<string | null>(null)

  async function onAccept() {
    try {
      const { slug } = await accept({ data: { invitationId: id } })
      await router.navigate({ to: '/t/$tenant/projects', params: { tenant: slug } })
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-4 text-2xl font-semibold">Join organization</h1>
      <p className="mb-6 text-gray-600">Signed in as {email}.</p>
      <ErrorText error={error} />
      <button type="button" disabled={!hydrated} onClick={onAccept} className={buttonClass}>
        Accept invitation
      </button>
    </main>
  )
}
