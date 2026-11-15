import { useEffect, useRef, useState } from 'react'

// Page markup comes from components/ui (ADR-0046); these are the non-visual helpers pages share.

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

/**
 * One action at a time from this page. The ref is set before the first await, so a second click or
 * Enter that arrives before the re-render that disables the control sends nothing. `pending` names
 * which action runs (a row's id, say), so its control can say so. It's no server-side
 * deduplication: another tab can still send the same request.
 */
export function usePending<K = true>() {
  const running = useRef(false)
  const [pending, setPending] = useState<K | null>(null)
  async function run(action: () => Promise<void>, key: K = true as K) {
    if (running.current) return
    running.current = true
    setPending(key)
    try {
      await action()
    } finally {
      running.current = false
      setPending(null)
    }
  }
  return { run, pending, busy: pending !== null }
}
