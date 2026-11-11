import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type FormEvent } from 'react'
import { createOrganizationFn, getViewerFn } from '../modules/organizations/functions'
import { messageOf, useHydrated } from '../lib/ui'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export const Route = createFileRoute('/orgs/new')({
  loader: async () => {
    const viewer = await getViewerFn()
    if (!viewer) throw redirect({ to: '/login', search: { redirect: '/orgs/new' } })
    return { hasOrganizations: viewer.organizations.length > 0 }
  },
  component: NewOrganization,
})

function NewOrganization() {
  const { hasOrganizations } = Route.useLoaderData()
  const hydrated = useHydrated()
  const router = useRouter()
  const create = useServerFn(createOrganizationFn)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    try {
      const { slug } = await create({
        data: { name: String(form.get('name')), slug: String(form.get('slug')) },
      })
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
            <h1 className="text-2xl font-semibold">New organization</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="gap-4">
          <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
              <Input id="organization-name" name="name" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="organization-slug">URL slug</FieldLabel>
              <Input
                id="organization-slug"
                name="slug"
                required
                minLength={2}
                maxLength={48}
                // Mirrors contracts' TenantSlug. Browsers compile `pattern` with the `v` flag, where a
                // bare `-` in a class is a syntax error and the whole pattern is ignored: keep `\-`.
                pattern="[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?"
              />
            </Field>
            <FieldError>{error}</FieldError>
            <Button type="submit" disabled={!hydrated}>
              Create organization
            </Button>
          </form>
          {hasOrganizations && (
            <p className="text-sm">
              <Link to="/" className={standaloneLink}>
                Cancel
              </Link>
            </p>
          )}
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
// A link on its own line: at least 24 px tall (WCAG 2.5.8).
const standaloneLink = 'inline-flex min-h-6 items-center text-primary underline underline-offset-4'
