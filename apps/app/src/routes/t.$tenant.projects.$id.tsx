import { createFileRoute, useLoaderData, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type FormEvent } from 'react'
import { deleteProjectFn, getProjectFn, updateProjectFn } from '../modules/projects/functions'
import { messageOf, useHydrated } from '../lib/ui'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

// A project id from another tenant (or unknown) is a 404 here too: the service scopes by tenant.
export const Route = createFileRoute('/t/$tenant/projects/$id')({
  loader: ({ params }) => getProjectFn({ data: { tenant: params.tenant, id: params.id } }),
  component: ProjectDetail,
})

function ProjectDetail() {
  const hydrated = useHydrated()
  const project = Route.useLoaderData()
  // UI hint only; the server refuses a delete without `project:delete` (403).
  const canDelete = useLoaderData({ from: '/t/$tenant' }).capabilities.includes('project:delete')
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
    <section className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold wrap-anywhere">{project.name}</h2>
      <Card>
        <CardContent>
          <form method="post" onSubmit={onSave} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="project-name">Project name</FieldLabel>
              <Input
                id="project-name"
                name="name"
                defaultValue={project.name}
                required
                maxLength={120}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-description">Description</FieldLabel>
              <Input
                id="project-description"
                name="description"
                defaultValue={project.description ?? ''}
                maxLength={2000}
              />
            </Field>
            <FieldError>{error}</FieldError>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={!hydrated}>
                Save
              </Button>
              {canDelete && (
                <Button type="button" variant="destructive" disabled={!hydrated} onClick={onDelete}>
                  Delete project
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  )
}
