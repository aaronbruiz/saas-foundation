import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import {
  listInvitationsFn,
  listMembersFn,
  removeMemberFn,
  revokeInvitationFn,
  updateMemberRoleFn,
} from '../modules/organizations/functions'
import { ErrorText, messageOf, useHydrated } from '../lib/ui'

// Every member sees the members; pending invitations only with `member:invite` (owner decision
// 2026-10-29). Owner rows have no actions (owner decision 2026-10-30). The capabilities from the
// layout are UI hints: the server functions check them again.
export const Route = createFileRoute('/t/$tenant/members')({
  loader: async ({ params, parentMatchPromise }) => {
    const { loaderData } = await parentMatchPromise
    const data = { data: { tenant: params.tenant } }
    const [members, invitations] = await Promise.all([
      listMembersFn(data),
      loaderData?.capabilities.includes('member:invite') ? listInvitationsFn(data) : null,
    ])
    return { members, invitations, canManage: !!loaderData?.capabilities.includes('member:manage') }
  },
  component: Members,
})

function Members() {
  const hydrated = useHydrated()
  const { members, invitations, canManage } = Route.useLoaderData()
  const { tenant } = Route.useParams()
  const router = useRouter()
  const revoke = useServerFn(revokeInvitationFn)
  const remove = useServerFn(removeMemberFn)
  const updateRole = useServerFn(updateMemberRoleFn)
  const [error, setError] = useState<string | null>(null)

  async function onRevoke(invitationId: string) {
    try {
      await revoke({ data: { tenant, invitationId } })
      setError(null)
      await router.invalidate()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function onRemove(memberId: string) {
    try {
      const { removedSelf } = await remove({ data: { tenant, memberId } })
      setError(null)
      // Removing yourself ends your access here: this page's loader would answer 404.
      if (removedSelf) await router.navigate({ to: '/' })
      else await router.invalidate()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function onUpdateRole(memberId: string, role: 'member' | 'admin') {
    try {
      await updateRole({ data: { tenant, memberId, role } })
      setError(null)
      await router.invalidate()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="mb-4 text-lg font-semibold">Members</h2>
        <ul className="divide-y rounded border bg-white">
          {members.map((m) => {
            const newRole = m.role === 'admin' ? 'member' : 'admin'
            const isOwner = m.role.split(',').some((r) => r.trim() === 'owner')
            return (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-4 p-3">
                <span>
                  {m.name} <span className="text-gray-500">{m.email}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-gray-600">{m.role}</span>
                  {canManage && !isOwner && (
                    <>
                      <button
                        type="button"
                        disabled={!hydrated}
                        onClick={() => onUpdateRole(m.id, newRole)}
                        aria-label={`Make ${m.email} ${newRole}`}
                        className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                      >
                        Make {newRole}
                      </button>
                      <button
                        type="button"
                        disabled={!hydrated}
                        onClick={() => onRemove(m.id)}
                        aria-label={`Remove ${m.email}`}
                        className="rounded border border-red-700 px-3 py-1 text-sm text-red-700 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      {invitations && (
        <div>
          <h3 className="mb-4 font-medium">Pending invitations</h3>
          {invitations.length === 0 ? (
            <p className="text-gray-600">No pending invitations.</p>
          ) : (
            <ul className="divide-y rounded border bg-white">
              {invitations.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-4 p-3">
                  <span>
                    {i.email} <span className="text-sm text-gray-600">{i.role ?? 'member'}</span>
                    <span className="block text-sm text-gray-500">
                      Expires {new Date(i.expiresAt).toLocaleDateString()}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={!hydrated}
                    onClick={() => onRevoke(i.id)}
                    aria-label={`Revoke invitation for ${i.email}`}
                    className="rounded border border-red-700 px-3 py-1 text-sm text-red-700 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ErrorText error={error} />
    </section>
  )
}
