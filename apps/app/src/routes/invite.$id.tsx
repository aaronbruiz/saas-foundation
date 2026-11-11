import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { acceptInvitationFn, getViewerFn } from '../modules/organizations/functions'
import { messageOf, useHydrated } from '../lib/ui'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
    <main className={authMain}>
      <Card className={authCard}>
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl font-semibold">Join organization</h1>
          </CardTitle>
          <CardDescription>
            <p>Signed in as {email}.</p>
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-4">
          <FieldError>{error}</FieldError>
          <Button type="button" disabled={!hydrated} onClick={onAccept}>
            Accept invitation
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}

// The auth pages' frame (ADR-0046): flat and edge to edge below `sm`, like the pages with
// Turnstile, whose fixed 300 px widget has to fit a 320 px screen.
const authMain = 'mx-auto w-full max-w-sm px-2.5 py-8 sm:px-4'
const authCard =
  'max-sm:gap-6 max-sm:overflow-visible max-sm:bg-transparent max-sm:shadow-none max-sm:ring-0 max-sm:[--card-spacing:--spacing(0)]'
