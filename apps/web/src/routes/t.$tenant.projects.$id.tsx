import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type FormEvent } from 'react'
import { deleteProjectFn, getProjectFn, updateProjectFn } from '../modules/projects/functions'
import { ErrorText, Field, buttonClass, inputClass, messageOf, useHydrated } from '../lib/ui'

// A project id from another tenant (or unknown) is a 404 here too: the service scopes by tenant.
export const Route = createFileRoute('/t/$tenant/projects/$id')({
  loader: ({ params }) => getProjectFn({ data: { tenant: params.tenant, id: params.id } }),
  component: ProjectDetail,
})

function ProjectDetail() {
  const hydrated = useHydrated()
  const project = Route.useLoaderData()
  const { tenant, id } = Route.useParams()
  const router = useRouter()
  const update = useServerFn(updateProjectFn)
  const remove = useServerFn(deleteProjectFn)
  const [error, setError] = useState<string | null>(null)

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    try {
      await update({
        data: {
          tenant,
          id,
          project: {
            name: String(form.get('name')),
            description: String(form.get('description') ?? ''),
          },
        },
      })
      setError(null)
      await router.invalidate()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function onDelete() {
    try {
      await remove({ data: { tenant, id } })
      await router.navigate({ to: '/t/$tenant/projects', params: { tenant } })
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold">{project.name}</h2>
      <form method="post" onSubmit={onSave} className="space-y-4 rounded border bg-white p-4">
        <Field label="Project name">
          <input
            name="name"
            defaultValue={project.name}
            required
            maxLength={120}
            className={inputClass}
          />
        </Field>
        <Field label="Description">
          <input
            name="description"
            defaultValue={project.description ?? ''}
            maxLength={2000}
            className={inputClass}
          />
        </Field>
        <ErrorText error={error} />
        <div className="flex gap-3">
          <button type="submit" disabled={!hydrated} className={buttonClass}>
            Save
          </button>
          <button
            type="button"
            disabled={!hydrated}
            onClick={onDelete}
            className="rounded border border-red-700 px-4 py-2 text-red-700"
          >
            Delete project
          </button>
        </div>
      </form>
    </section>
  )
}
