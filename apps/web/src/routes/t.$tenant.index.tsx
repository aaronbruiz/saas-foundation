import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/t/$tenant/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/t/$tenant/projects', params })
  },
})
