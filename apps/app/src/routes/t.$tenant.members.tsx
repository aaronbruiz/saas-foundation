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
import { messageOf, useHydrated } from '../lib/ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'

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
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Members</h2>
        <ul className={list}>
          {members.map((m) => {
            const newRole = m.role === 'admin' ? 'member' : 'admin'
            const isOwner = m.role.split(',').some((r) => r.trim() === 'owner')
            return (
              <li key={m.id} className={row}>
                <span className="min-w-0 wrap-anywhere">
                  {m.name} <span className="text-muted-foreground">{m.email}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{m.role}</Badge>
                  {canManage && !isOwner && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!hydrated}
                        onClick={() => onUpdateRole(m.id, newRole)}
                        aria-label={`Make ${m.email} ${newRole}`}
                      >
                        Make {newRole}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={!hydrated}
                        onClick={() => onRemove(m.id)}
                        aria-label={`Remove ${m.email}`}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      {invitations && (
        <div className="flex flex-col gap-4">
          <h3 className="font-medium">Pending invitations</h3>
          {invitations.length === 0 ? (
            <p className="text-muted-foreground">No pending invitations.</p>
          ) : (
            <ul className={list}>
              {invitations.map((i) => (
                <li key={i.id} className={row}>
                  <span className="min-w-0 wrap-anywhere">
                    {i.email}{' '}
                    <span className="text-sm text-muted-foreground">{i.role ?? 'member'}</span>
                    <span className="block text-sm text-muted-foreground">
                      Expires {new Date(i.expiresAt).toLocaleDateString()}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={!hydrated}
                    onClick={() => onRevoke(i.id)}
                    aria-label={`Revoke invitation for ${i.email}`}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <FieldError>{error}</FieldError>
    </section>
  )
}

const list =
  'divide-y rounded-xl bg-card text-sm text-card-foreground shadow-xs ring-1 ring-foreground/10'
const row = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3'
