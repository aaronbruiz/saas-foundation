import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useRef, useState } from 'react'
import {
  listInvitationsFn,
  listMembersFn,
  removeMemberFn,
  revokeInvitationFn,
  updateMemberRoleFn,
} from '../modules/organizations/functions'
import { messageOf, useHydrated, usePending } from '../lib/ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { pageTitle } from '@/lib/title'

// Every member sees the members; pending invitations only with `member:invite` (owner decision
// 2026-10-29). Owner rows have no actions (owner decision 2026-10-30). The capabilities from the
// layout are UI hints: the server functions check them again.
export const Route = createFileRoute('/t/$tenant/members')({
  head: () => pageTitle('Members'),
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
  // One row action at a time: `pending` names it, so its own button says what it's doing.
  const { run, pending, busy } = usePending<string>()
  const disabled = !hydrated || busy
  // A removed row takes its focused button with it: focus goes to its list's heading.
  const membersHeading = useRef<HTMLHeadingElement>(null)
  const invitationsHeading = useRef<HTMLHeadingElement>(null)

  // The write's failure is the row's error; the refresh after a write that succeeded isn't.
  function act<T>(key: string, action: () => Promise<T>, after: (result: T) => Promise<void>) {
    void run(async () => {
      setError(null)
      let result: T
      try {
        result = await action()
      } catch (err) {
        return setError(messageOf(err))
      }
      await after(result)
    }, key)
  }

  function onRevoke(invitationId: string) {
    act(
      `revoke:${invitationId}`,
      () => revoke({ data: { tenant, invitationId } }),
      async () => {
        await router.invalidate()
        invitationsHeading.current?.focus()
      },
    )
  }

  function onRemove(memberId: string) {
    act(
      `remove:${memberId}`,
      () => remove({ data: { tenant, memberId } }),
      async ({ removedSelf }) => {
        // Removing yourself ends your access here: this page's loader would answer 404.
        if (removedSelf) return void (await router.navigate({ to: '/' }))
        await router.invalidate()
        membersHeading.current?.focus()
      },
    )
  }

  function onUpdateRole(memberId: string, role: 'member' | 'admin') {
    act(
      `role:${memberId}`,
      () => updateRole({ data: { tenant, memberId, role } }),
      async () => {
        await router.invalidate()
      },
    )
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <h2 ref={membersHeading} tabIndex={-1} className="text-lg font-semibold outline-none">
          Members
        </h2>
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
                        disabled={disabled}
                        aria-busy={pending === `role:${m.id}` || undefined}
                        onClick={() => onUpdateRole(m.id, newRole)}
                        aria-label={`Make ${m.email} ${newRole}`}
                      >
                        {pending === `role:${m.id}` ? 'Saving…' : `Make ${newRole}`}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={disabled}
                        aria-busy={pending === `remove:${m.id}` || undefined}
                        onClick={() => onRemove(m.id)}
                        aria-label={`Remove ${m.email}`}
                      >
                        {pending === `remove:${m.id}` ? 'Removing…' : 'Remove'}
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
          <h3 ref={invitationsHeading} tabIndex={-1} className="font-medium outline-none">
            Pending invitations
          </h3>
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
                    disabled={disabled}
                    aria-busy={pending === `revoke:${i.id}` || undefined}
                    onClick={() => onRevoke(i.id)}
                    aria-label={`Revoke invitation for ${i.email}`}
                  >
                    {pending === `revoke:${i.id}` ? 'Revoking…' : 'Revoke'}
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
