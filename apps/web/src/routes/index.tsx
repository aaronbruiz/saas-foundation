import { createFileRoute, redirect } from '@tanstack/react-router'
import { getViewerFn } from '../modules/organizations/functions'

// Landing: signed out → /login; no organization yet → /orgs/new; otherwise the first tenant.
export const Route = createFileRoute('/')({
  loader: async () => {
    const viewer = await getViewerFn()
    if (!viewer) throw redirect({ to: '/login', search: { redirect: '/' } })
    const first = viewer.organizations[0]
    if (!first) throw redirect({ to: '/orgs/new' })
    throw redirect({ to: '/t/$tenant/projects', params: { tenant: first.slug } })
  },
})
