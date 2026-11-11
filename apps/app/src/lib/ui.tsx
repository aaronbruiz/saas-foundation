import { useEffect, useState } from 'react'

// Page markup comes from components/ui (ADR-0046); these are the two non-visual helpers pages share.

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

/**
 * True once React has hydrated. Submit buttons stay disabled until then: a native (pre-hydration)
 * submit would otherwise send the form as GET, leaking fields such as passwords into the URL.
 */
export function useHydrated() {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return hydrated
}
