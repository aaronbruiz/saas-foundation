import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { acceptInvitationFn, getViewerFn } from '../modules/organizations/functions'
import { messageOf, useHydrated } from '../lib/ui'
import { AuthLayout } from '@/components/ui/auth-layout'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'

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
    <AuthLayout title="Join organization" description={<p>Signed in as {email}.</p>}>
      <FieldError>{error}</FieldError>
      <Button type="button" disabled={!hydrated} onClick={onAccept}>
        Accept invitation
      </Button>
    </AuthLayout>
  )
}
