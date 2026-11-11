import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  deleteOrganizationFn,
  getViewerFn,
  leaveOrganizationFn,
  listMembersFn,
  renameOrganizationFn,
  transferOwnershipFn,
} from '../modules/organizations/functions'
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
import { toast } from 'sonner'

// Organization settings (owner decisions 2026-10-31). The capabilities from the layout only pick
// the sections shown; every server function checks them again.
export const Route = createFileRoute('/t/$tenant/settings')({
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
        <LeaveSection />
        {canDelete && <DeleteForm name={name} />}
      </section>
    </div>
  )
}

/** Runs one action at a time and keeps its error; the action decides what happens on success. */
function useAction() {
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
  return { run, error, disabled: !hydrated || busy }
}

/**
 * A settings section: its heading is an h3 under the page's h2, or an h4 inside the danger zone,
 * so the page keeps one outline.
 */
function Section({
  title,
  description,
  danger = false,
  level = 3,
  children,
}: {
  title: string
  description?: ReactNode
  danger?: boolean
  level?: 3 | 4
  children: ReactNode
}) {
  const Heading = level === 4 ? 'h4' : 'h3'
  return (
    <Card className={danger ? 'ring-destructive/40' : undefined}>
      <CardHeader>
        <CardTitle>
          <Heading className={danger ? 'text-base text-destructive' : 'text-base'}>{title}</Heading>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function RenameForm({ name }: { name: string }) {
  const { tenant } = Route.useParams()
  const router = useRouter()
  const rename = useServerFn(renameOrganizationFn)
  const { run, error, disabled } = useAction()

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
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
          <Input
            id="organization-name"
            name="name"
            required
            maxLength={120}
            defaultValue={name}
            aria-invalid={error ? true : undefined}
          />
          <FieldError>{error}</FieldError>
        </Field>
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
  const { run, error, disabled } = useAction()
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

  function onConfirm() {
    if (!pending) return
    const { id: memberId, email } = pending
    setConfirming(false)
    void run(async () => {
      await transfer({ data: { tenant, memberId } })
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
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="new-owner">New owner</FieldLabel>
            {/* A native select (AGENTS.md "UI"): a simple single choice, submitted with the form. */}
            <NativeSelect
              id="new-owner"
              name="memberId"
              required
              className="w-full sm:w-96"
              value={selected?.id ?? ''}
              onChange={(e) => setSelectedId(e.currentTarget.value)}
              aria-describedby="new-owner-selected"
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
            <FieldError>{error}</FieldError>
          </Field>
          <div>
            <Button ref={submitRef} type="submit" disabled={disabled}>
              Transfer ownership
            </Button>
          </div>
        </form>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
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
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructiveSolid"
              disabled={disabled}
              onClick={onConfirm}
            >
              Transfer ownership
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
    <Section
      title="Leave"
      level={4}
      description="You lose access to this organization and its projects."
    >
      <div className="flex flex-col gap-3">
        <FieldError>{error}</FieldError>
        <div>
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
        </div>
      </div>
    </Section>
  )
}

function DeleteForm({ name }: { name: string }) {
  const { tenant } = Route.useParams()
  const router = useRouter()
  const remove = useServerFn(deleteOrganizationFn)
  const { run, error, disabled } = useAction()

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const confirmName = String(new FormData(e.currentTarget).get('confirmName'))
    void run(async () => {
      await remove({ data: { tenant, confirmName } })
      await router.navigate({ to: '/' })
    })
  }

  return (
    <Section
      title="Delete organization"
      danger
      level={4}
      description={
        <>
          This deletes its members, invitations, projects and billing record. Type{' '}
          <strong className="text-foreground">{name}</strong> to confirm.
        </>
      }
    >
      <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="confirm-name">Organization name to confirm</FieldLabel>
          <Input
            id="confirm-name"
            name="confirmName"
            required
            autoComplete="off"
            aria-invalid={error ? true : undefined}
          />
          <FieldError>{error}</FieldError>
        </Field>
        <div>
          <Button type="submit" variant="destructive" disabled={disabled}>
            Delete organization
          </Button>
        </div>
      </form>
    </Section>
  )
}
