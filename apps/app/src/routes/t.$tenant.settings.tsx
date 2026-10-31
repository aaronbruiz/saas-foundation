import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type FormEvent } from 'react'
import {
  deleteOrganizationFn,
  getViewerFn,
  leaveOrganizationFn,
  listMembersFn,
  renameOrganizationFn,
  transferOwnershipFn,
} from '../modules/organizations/functions'
import { ErrorText, Field, buttonClass, inputClass, messageOf, useHydrated } from '../lib/ui'

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
    <div className="space-y-10">
      {canRename && <RenameForm name={name} />}
      {canTransfer && <TransferForm candidates={candidates} />}
      <LeaveSection />
      {canDelete && <DeleteForm name={name} />}
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

function RenameForm({ name }: { name: string }) {
  const { tenant } = Route.useParams()
  const router = useRouter()
  const rename = useServerFn(renameOrganizationFn)
  const { run, error, disabled } = useAction()
  const [saved, setSaved] = useState(false)

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaved(false)
    const next = String(new FormData(e.currentTarget).get('name'))
    void run(async () => {
      await rename({ data: { tenant, name: next } })
      setSaved(true)
      await router.invalidate()
    })
  }

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">Name</h2>
      <p className="mb-4 text-sm text-gray-600">
        This changes the display name only. The organization&apos;s URL stays the same.
      </p>
      <form method="post" onSubmit={onSubmit} className="space-y-4">
        <Field label="Organization name">
          <input name="name" required maxLength={120} defaultValue={name} className={inputClass} />
        </Field>
        <ErrorText error={error} />
        {saved && (
          <p role="status" className="text-sm">
            Name saved.
          </p>
        )}
        <button type="submit" disabled={disabled} className={buttonClass}>
          Save name
        </button>
      </form>
    </section>
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

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const memberId = String(new FormData(e.currentTarget).get('memberId'))
    void run(async () => {
      await transfer({ data: { tenant, memberId } })
      await router.invalidate()
    })
  }

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">Transfer ownership</h2>
      <p className="mb-4 text-sm text-gray-600">
        The member you choose becomes an owner, and you become an admin.
      </p>
      {candidates.length === 0 ? (
        <p className="text-sm">Invite someone first: there&apos;s no other member to choose.</p>
      ) : (
        <form method="post" onSubmit={onSubmit} className="space-y-4">
          <Field label="New owner">
            <select name="memberId" required className={inputClass}>
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email} ({m.role})
                </option>
              ))}
            </select>
          </Field>
          <ErrorText error={error} />
          <button type="submit" disabled={disabled} className={buttonClass}>
            Transfer ownership
          </button>
        </form>
      )}
    </section>
  )
}

function LeaveSection() {
  const { tenant } = Route.useParams()
  const router = useRouter()
  const leave = useServerFn(leaveOrganizationFn)
  const { run, error, disabled } = useAction()

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">Leave</h2>
      <ErrorText error={error} />
      <button
        type="button"
        disabled={disabled}
        className={`mt-2 ${buttonClass}`}
        onClick={() =>
          void run(async () => {
            await leave({ data: { tenant } })
            await router.navigate({ to: '/' })
          })
        }
      >
        Leave organization
      </button>
    </section>
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
    <section>
      <h2 className="mb-4 text-lg font-semibold">Delete organization</h2>
      <p className="mb-4 text-sm text-gray-600">
        This deletes its members, invitations, projects and billing record. Type{' '}
        <strong>{name}</strong> to confirm.
      </p>
      <form method="post" onSubmit={onSubmit} className="space-y-4">
        <Field label="Organization name to confirm">
          <input name="confirmName" required autoComplete="off" className={inputClass} />
        </Field>
        <ErrorText error={error} />
        <button type="submit" disabled={disabled} className={buttonClass}>
          Delete organization
        </button>
      </form>
    </section>
  )
}
