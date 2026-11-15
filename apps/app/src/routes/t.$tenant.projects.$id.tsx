import { createFileRoute, useLoaderData, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useRef, useState, type FormEvent, type RefObject } from 'react'
import { deleteProjectFn, getProjectFn, updateProjectFn } from '../modules/projects/functions'
import { messageOf, useHydrated, usePending } from '../lib/ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
  const organization = useLoaderData({ from: '/t/$tenant' })
  const canDelete = organization.capabilities.includes('project:delete')
  const { tenant, id } = Route.useParams()
  const router = useRouter()
  const update = useServerFn(updateProjectFn)
  const [error, setError] = useState<string | null>(null)
  const { run, busy } = usePending()
  const [confirming, setConfirming] = useState(false)
  // Each opening mounts a new dialog body, so a reopened dialog starts without the last outcome.
  const [opened, setOpened] = useState(0)
  // Cancel and Escape return focus here, the page's Delete project button.
  const deleteRef = useRef<HTMLButtonElement>(null)
  // While the deletion runs, the dialog can't be closed: its outcome is shown in it.
  const deletingRef = useRef(false)

  function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    void run(async () => {
      setError(null)
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
      } catch (err) {
        return setError(messageOf(err))
      }
      await router.invalidate()
    })
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
              <Button type="submit" disabled={!hydrated || busy} aria-busy={busy || undefined}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              {canDelete && (
                <Button
                  ref={deleteRef}
                  type="button"
                  variant="destructive"
                  disabled={!hydrated || busy}
                  onClick={() => {
                    setOpened((n) => n + 1)
                    setConfirming(true)
                  }}
                >
                  Delete project
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
      {canDelete && (
        <AlertDialog
          open={confirming}
          onOpenChange={(next) => {
            if (!next && deletingRef.current) return
            setConfirming(next)
          }}
        >
          <DeleteProjectDialog
            key={opened}
            name={project.name}
            organization={organization.name}
            deletingRef={deletingRef}
            finalFocus={deleteRef}
          />
        </AlertDialog>
      )}
    </section>
  )
}

/**
 * Deleting a project can't be undone in the app (AGENTS.md "UI": confirm by consequence). The
 * server checks `project:delete` again; this dialog only prevents accidents.
 */
function DeleteProjectDialog({
  name,
  organization,
  deletingRef,
  finalFocus,
}: {
  name: string
  organization: string
  deletingRef: RefObject<boolean>
  finalFocus: RefObject<HTMLButtonElement | null>
}) {
  const hydrated = useHydrated()
  const { tenant, id } = Route.useParams()
  const router = useRouter()
  const remove = useServerFn(deleteProjectFn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The least destructive choice gets focus first (APG alert dialog).
  const cancelRef = useRef<HTMLButtonElement>(null)

  async function onConfirm() {
    // The ref, not state: a second click can arrive before the re-render that disables the button.
    if (deletingRef.current) return
    deletingRef.current = true
    setBusy(true)
    setError(null)
    try {
      await remove({ data: { tenant, id } })
    } catch (err) {
      deletingRef.current = false
      setBusy(false)
      return setError(deleteFailure(err, name))
    }
    deletingRef.current = false
    // Replace: Back would land on the deleted project's 404.
    await router.navigate({ to: '/t/$tenant/projects', params: { tenant }, replace: true })
  }

  return (
    <AlertDialogContent initialFocus={cancelRef} finalFocus={finalFocus}>
      <AlertDialogHeader className="place-items-start text-left">
        <AlertDialogTitle className="wrap-anywhere">Delete {name}?</AlertDialogTitle>
        <AlertDialogDescription className="wrap-anywhere">
          The project and its data are deleted for everyone in {organization}. You can&apos;t undo
          this from the app.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <FieldError>{error}</FieldError>
      <AlertDialogFooter>
        <AlertDialogCancel ref={cancelRef} disabled={busy}>
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction
          type="button"
          variant="destructiveSolid"
          disabled={!hydrated || busy}
          aria-busy={busy || undefined}
          onClick={onConfirm}
        >
          {busy ? 'Deleting…' : 'Delete project'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

// `forbidden` (a role without `project:delete`) proves nothing was deleted; any other answer may
// follow the delete's commit.
function deleteFailure(err: unknown, name: string) {
  if (err instanceof Error && err.message === 'forbidden') return err.message
  return `We couldn't confirm ${name} was deleted. Reload the page to check, and try again if it's still there.`
}
