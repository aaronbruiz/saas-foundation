import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type FormEvent } from 'react'
import { createOrganizationFn, getViewerFn } from '../modules/organizations/functions'
import { ErrorText, Field, buttonClass, inputClass, messageOf, useHydrated } from '../lib/ui'

export const Route = createFileRoute('/orgs/new')({
  loader: async () => {
    if (!(await getViewerFn())) throw redirect({ to: '/login', search: { redirect: '/orgs/new' } })
  },
  component: NewOrganization,
})

function NewOrganization() {
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
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-semibold">New organization</h1>
      <form method="post" onSubmit={onSubmit} className="space-y-4">
        <Field label="Organization name">
          <input name="name" required className={inputClass} />
        </Field>
        <Field label="URL slug">
          <input
            name="slug"
            required
            minLength={2}
            maxLength={48}
            // Mirrors contracts' TenantSlug. Browsers compile `pattern` with the `v` flag, where a
            // bare `-` in a class is a syntax error and the whole pattern is ignored: keep `\-`.
            pattern="[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?"
            className={inputClass}
          />
        </Field>
        <ErrorText error={error} />
        <button type="submit" disabled={!hydrated} className={buttonClass}>
          Create organization
        </button>
      </form>
    </main>
  )
}
