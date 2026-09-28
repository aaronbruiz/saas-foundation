import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type FormEvent } from 'react'
import { createProjectFn, listProjectsFn } from '../modules/projects/functions'
import { ErrorText, Field, buttonClass, inputClass, messageOf, useHydrated } from '../lib/ui'

export const Route = createFileRoute('/t/$tenant/projects/')({
  loader: ({ params }) => listProjectsFn({ data: { tenant: params.tenant } }),
  component: Projects,
})

function Projects() {
  const hydrated = useHydrated()
  const projects = Route.useLoaderData()
  const { tenant } = Route.useParams()
  const router = useRouter()
  const create = useServerFn(createProjectFn)
  const [error, setError] = useState<string | null>(null)

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formEl = e.currentTarget
    const form = new FormData(formEl)
    const description = String(form.get('description') ?? '').trim()
    try {
      await create({
        data: {
          tenant,
          project: { name: String(form.get('name')), ...(description ? { description } : {}) },
        },
      })
      formEl.reset()
      setError(null)
      await router.invalidate()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">Projects</h2>
      {projects.length === 0 ? (
        <p className="mb-6 text-gray-600">No projects yet.</p>
      ) : (
        <ul className="mb-6 divide-y rounded border bg-white">
          {projects.map((p) => (
            <li key={p.id} className="p-3">
              <Link
                to="/t/$tenant/projects/$id"
                params={{ tenant, id: p.id }}
                className="underline"
              >
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <form method="post" onSubmit={onCreate} className="space-y-4 rounded border bg-white p-4">
        <h3 className="font-medium">New project</h3>
        <Field label="Project name">
          <input name="name" required maxLength={120} className={inputClass} />
        </Field>
        <Field label="Description">
          <input name="description" maxLength={2000} className={inputClass} />
        </Field>
        <ErrorText error={error} />
        <button type="submit" disabled={!hydrated} className={buttonClass}>
          Create project
        </button>
      </form>
    </section>
  )
}
