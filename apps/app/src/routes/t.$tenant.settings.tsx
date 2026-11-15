import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import {
  deleteOrganizationFn,
  getViewerFn,
  leaveOrganizationFn,
  listMembersFn,
  renameOrganizationFn,
  transferOwnershipFn,
} from '../modules/organizations/functions'
import { DELETION_REFUSALS } from '../lib/deletion-refusals'
import { messageOf, useHydrated } from '../lib/ui'
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { pageTitle } from '@/lib/title'

// Organization settings (owner decisions 2026-10-31). The capabilities from the layout only pick
// the sections shown; every server function checks them again.
export const Route = createFileRoute('/t/$tenant/settings')({
  head: () => pageTitle('Settings'),
  loader: async ({ params, parentMatchPromise }) => {
    const { loaderData } = await parentMatchPromise
    const capabilities = loaderData?.capabilities ?? []
    const canTransfer = capabilities.includes('organization:transfer')
    return {
      name: loaderData?.name ?? '',
      canRename: capabilities.includes('organization:rename'),
      canTransfer,
      canDelete: capabilities.includes('organization:delete'),
      candidates: canTransfer ? await transferCandidates(params.tenant) : [],
    }
  },
  component: Settings,
})

/**
 * Everyone but the caller. Another owner stays listed: choosing one finishes a transfer whose
 * demotion failed, which would otherwise have no way back after a reload.
 */
async function transferCandidates(tenant: string) {
  const [members, viewer] = await Promise.all([listMembersFn({ data: { tenant } }), getViewerFn()])
  return members.filter((m) => m.email !== viewer?.email)
}

function Settings() {
  const { name, canRename, canTransfer, canDelete, candidates } = Route.useLoaderData()
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">Settings</h2>
      {canRename && <RenameForm name={name} />}
      {canTransfer && <TransferForm candidates={candidates} />}
      <section aria-labelledby="danger-zone" className="flex flex-col gap-4">
        <h3 id="danger-zone" className="text-base font-semibold text-destructive">
          Danger zone
        </h3>
        <Card className="gap-0 py-0 ring-destructive/40">
          <LeaveSection />
          {canDelete && (
            <>
              <Separator />
              <DeleteSection name={name} otherMembers={canTransfer ? candidates.length : null} />
            </>
          )}
        </Card>
      </section>
    </div>
  )
}

/**
 * Runs one action at a time and keeps its error; the action decides what happens on success.
 * `fieldErrors` are the server's answers that mean the typed value was invalid: those mark the
 * form's field; any other failure is a form-level alert (AGENTS.md "UI").
 */
function useAction(fieldErrors: string[] = []) {
  const hydrated = useHydrated()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }
  const fieldError = error !== null && fieldErrors.includes(error)
  return { run, error, fieldError, disabled: !hydrated || busy }
}

/** A settings section: its heading is an h3 under the page's h2, so the page keeps one outline. */
function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3 className="text-base">{title}</h3>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/**
 * One action in the danger zone: an h4 under its h3, the consequence, the action, and below them
 * the action's form-level alert, if any.
 */
function DangerRow({
  title,
  description,
  alert,
  children,
}: {
  title: string
  description: string
  alert?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex flex-col gap-1">
          <h4 className="text-base font-medium">{title}</h4>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="shrink-0">{children}</div>
      </div>
      {alert}
    </div>
  )
}

function RenameForm({ name }: { name: string }) {
  const { tenant } = Route.useParams()
  const router = useRouter()
  const rename = useServerFn(renameOrganizationFn)
  const { run, error, fieldError, disabled } = useAction(['invalid input'])

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const next = String(new FormData(e.currentTarget).get('name'))
    void run(async () => {
      await rename({ data: { tenant, name: next } })
      toast.success('Name saved.')
      await router.invalidate()
    })
  }

  return (
    <Section
      title="Name"
      description="This changes the display name only. The organization's URL stays the same."
    >
      <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field data-invalid={fieldError || undefined}>
          <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
          <Input
            id="organization-name"
            name="name"
            required
            maxLength={120}
            defaultValue={name}
            aria-invalid={fieldError || undefined}
            aria-describedby={fieldError ? 'organization-name-error' : undefined}
          />
          {fieldError && <FieldError id="organization-name-error">{error}</FieldError>}
        </Field>
        {!fieldError && <FieldError>{error}</FieldError>}
        <div>
          <Button type="submit" disabled={disabled}>
            Save name
          </Button>
        </div>
      </form>
    </Section>
  )
}

function TransferForm({
  candidates,
}: {
  candidates: { id: string; email: string; role: string }[]
}) {
  const { tenant } = Route.useParams()
  const router = useRouter()
  const transfer = useServerFn(transferOwnershipFn)
  const { run, error, fieldError, disabled } = useAction(['invalid input', 'Choose another member'])
  const [selectedId, setSelectedId] = useState(candidates[0]?.id ?? '')
  const selected = candidates.find((m) => m.id === selectedId) ?? candidates[0]
  // The member the open dialog asks about, fixed when it opens.
  const [pending, setPending] = useState<{ id: string; email: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  // Cancel and Escape return focus here, the page's Transfer ownership button.
  const submitRef = useRef<HTMLButtonElement>(null)

  // Submitting the form only opens the confirmation; nothing is sent until it's confirmed.
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const memberId = String(new FormData(e.currentTarget).get('memberId'))
    const member = candidates.find((m) => m.id === memberId)
    if (!member) return
    setPending({ id: member.id, email: member.email })
    setConfirming(true)
  }

  // The dialog stays open until the answer (AGENTS.md "UI"), then closes; the outcome is shown on
  // the page: a toast and the refreshed settings, or the form's error.
  const sending = useRef(false)
  function onConfirm() {
    if (!pending || sending.current) return
    sending.current = true
    const { id: memberId, email } = pending
    void run(async () => {
      try {
        await transfer({ data: { tenant, memberId } })
      } finally {
        sending.current = false
        setConfirming(false)
      }
      toast.success(`Ownership transferred to ${email}.`)
      await router.invalidate()
    })
  }

  return (
    <Section
      title="Transfer ownership"
      description="The member you choose becomes an owner, and you become an admin."
    >
      {candidates.length === 0 ? (
        <p className="text-sm">Invite someone first: there&apos;s no other member to choose.</p>
      ) : (
        <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field data-invalid={fieldError || undefined}>
            <FieldLabel htmlFor="new-owner">New owner</FieldLabel>
            {/* A native select (AGENTS.md "UI"): a simple single choice, submitted with the form. */}
            <NativeSelect
              id="new-owner"
              name="memberId"
              required
              className="w-full sm:w-96"
              value={selected?.id ?? ''}
              onChange={(e) => setSelectedId(e.currentTarget.value)}
              aria-describedby={
                fieldError ? 'new-owner-selected new-owner-error' : 'new-owner-selected'
              }
              aria-invalid={fieldError || undefined}
            >
              {candidates.map((m) => (
                <NativeSelectOption key={m.id} value={m.id}>
                  {m.email} ({m.role})
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {/* The full email wraps here: the closed select cuts a long one off on a phone. */}
            {selected && (
              <p id="new-owner-selected" className="text-sm break-all text-muted-foreground">
                Selected: {selected.email} ({selected.role})
              </p>
            )}
            {fieldError && <FieldError id="new-owner-error">{error}</FieldError>}
          </Field>
          {!fieldError && <FieldError>{error}</FieldError>}
          <div>
            <Button ref={submitRef} type="submit" disabled={disabled}>
              Transfer ownership
            </Button>
          </div>
        </form>
      )}
      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next && sending.current) return
          setConfirming(next)
        }}
      >
        <AlertDialogContent finalFocus={submitRef}>
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">
              Transfer ownership to {pending?.email}?
            </AlertDialogTitle>
            <AlertDialogDescription className="wrap-anywhere">
              {pending?.email} becomes an owner, and you become an admin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabled}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructiveSolid"
              disabled={disabled}
              aria-busy={(confirming && disabled) || undefined}
              onClick={onConfirm}
            >
              {confirming && disabled ? 'Transferring…' : 'Transfer ownership'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

function LeaveSection() {
  const { tenant } = Route.useParams()
  const router = useRouter()
  const leave = useServerFn(leaveOrganizationFn)
  const { run, error, disabled } = useAction()

  return (
    <DangerRow
      title="Leave"
      description="You lose access to this organization and its projects."
      alert={<FieldError>{error}</FieldError>}
    >
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          void run(async () => {
            await leave({ data: { tenant } })
            await router.navigate({ to: '/' })
          })
        }
      >
        Leave organization
      </Button>
    </DangerRow>
  )
}

/**
 * Deletion is confirmed in a dialog (owner decisions 2026-11-14): consequences first, then the
 * organization's exact name. The server checks the name and authorization again; ADR-0043's gate
 * decides whether the deletion can happen. `otherMembers` is the list this page loaded: a snapshot.
 */
function DeleteSection({ name, otherMembers }: { name: string; otherMembers: number | null }) {
  const hydrated = useHydrated()
  const [open, setOpen] = useState(false)
  // Each opening mounts a new dialog body, so a reopened dialog starts empty.
  const [opened, setOpened] = useState(0)
  // Cancel and Escape return focus here, the page's Delete organization button.
  const triggerRef = useRef<HTMLButtonElement>(null)
  // While the request runs, the dialog can't be closed: its outcome is shown in it.
  const busyRef = useRef(false)

  return (
    <DangerRow
      title="Delete organization"
      description="Everyone loses access, and its projects, invitations and memberships are deleted. This can't be undone."
    >
      <Button
        ref={triggerRef}
        type="button"
        variant="destructive"
        disabled={!hydrated}
        onClick={() => {
          setOpened((n) => n + 1)
          setOpen(true)
        }}
      >
        Delete organization
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && busyRef.current) return
          setOpen(next)
        }}
      >
        <DeleteDialog
          key={opened}
          name={name}
          otherMembers={otherMembers}
          busyRef={busyRef}
          finalFocus={triggerRef}
        />
      </AlertDialog>
    </DangerRow>
  )
}

function DeleteDialog({
  name,
  otherMembers,
  busyRef,
  finalFocus,
}: {
  name: string
  otherMembers: number | null
  busyRef: RefObject<boolean>
  finalFocus: RefObject<HTMLButtonElement | null>
}) {
  const { tenant } = Route.useParams()
  const router = useRouter()
  const remove = useServerFn(deleteOrganizationFn)
  const hydrated = useHydrated()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; field: boolean } | null>(null)
  // The consequences are met first: focus starts on the title, not on the field (APG modal dialog).
  const titleRef = useRef<HTMLHeadingElement>(null)
  const matches = typed === name

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // The ref, not state: a second Enter can arrive before the re-render that disables the button.
    if (!matches || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await remove({ data: { tenant, confirmName: typed } })
      busyRef.current = false
      await router.navigate({ to: '/', replace: true })
      toast.success(`${name} was deleted.`)
    } catch (err) {
      busyRef.current = false
      setBusy(false)
      setError(deleteFailure(err, name))
    }
  }

  return (
    <AlertDialogContent initialFocus={titleRef} finalFocus={finalFocus}>
      <form method="post" onSubmit={onSubmit} className="grid gap-6">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle ref={titleRef} tabIndex={-1} className="wrap-anywhere outline-none">
            Delete {name}?
          </AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-3 text-pretty">
            <ul className="list-disc space-y-1 pl-5 wrap-anywhere">
              <li>
                Everyone loses access to {name} at once, you included.
                {otherMembers !== null && otherMembers > 0 && (
                  <>
                    {' '}
                    {otherMembers === 1
                      ? '1 other member had access when this page loaded.'
                      : `${otherMembers} other members had access when this page loaded.`}
                  </>
                )}
              </li>
              <li>
                Its projects, invitations and memberships are deleted, and its billing account with
                Polar is removed.
              </li>
              <li>Your account and your other organizations aren&apos;t affected.</li>
            </ul>
            <p>
              This can&apos;t be undone. Deleted data isn&apos;t erased immediately: backups and our
              billing provider&apos;s order records keep copies for a limited time, as the{' '}
              {/* Not a link while the request runs: leaving would hide its outcome. */}
              {busy ? (
                'Privacy Policy'
              ) : (
                <Link to="/privacy" className="underline">
                  Privacy Policy
                </Link>
              )}{' '}
              describes.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field data-invalid={error?.field || undefined}>
          <FieldLabel htmlFor="confirm-name" className="block wrap-anywhere">
            Type <strong className="text-foreground">{name}</strong> to confirm
          </FieldLabel>
          <Input
            id="confirm-name"
            name="confirmName"
            required
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            readOnly={busy}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={error?.field || undefined}
            aria-describedby={error?.field ? 'confirm-name-error' : undefined}
          />
          {error?.field && <FieldError id="confirm-name-error">{error.text}</FieldError>}
        </Field>
        {error && !error.field && <FieldError>{error.text}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            type="submit"
            variant="destructiveSolid"
            disabled={!hydrated || !matches || busy}
            aria-busy={busy || undefined}
          >
            {busy ? 'Deleting…' : 'Delete organization'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  )
}

const MISMATCH = DELETION_REFUSALS.mismatch
// Anything else (the server's generic error, a proxy's error page, no answer) can follow ADR-0043's
// commit: the outcome is unknown, which is the safe default.
const REFUSALS = new Set<string>(Object.values(DELETION_REFUSALS))

function deleteFailure(err: unknown, name: string) {
  if (err instanceof Error && REFUSALS.has(err.message))
    return { text: err.message, field: err.message === MISMATCH }
  return {
    text: `We couldn't confirm ${name} was deleted. Reload the page to check, and try again if it's still there.`,
    field: false,
  }
}
