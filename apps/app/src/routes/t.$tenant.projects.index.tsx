import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type FormEvent } from 'react'
import { createProjectFn, listProjectsFn } from '../modules/projects/functions'
import { messageOf, useHydrated } from '../lib/ui'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

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
    <section className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">Projects</h2>
      {projects.length === 0 ? (
        <p className="text-muted-foreground">No projects yet.</p>
      ) : (
        <ul className="divide-y rounded-xl bg-card text-card-foreground shadow-xs ring-1 ring-foreground/10">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to="/t/$tenant/projects/$id"
                params={{ tenant, id: p.id }}
                className="flex min-h-11 items-center rounded-md px-4 py-2 text-primary underline underline-offset-4 wrap-anywhere hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
              >
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h3 className="text-base">New project</h3>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form method="post" onSubmit={onCreate} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="project-name">Project name</FieldLabel>
              <Input id="project-name" name="name" required maxLength={120} />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-description">Description</FieldLabel>
              <Input id="project-description" name="description" maxLength={2000} />
            </Field>
            <FieldError>{error}</FieldError>
            <div>
              <Button type="submit" disabled={!hydrated}>
                Create project
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  )
}
