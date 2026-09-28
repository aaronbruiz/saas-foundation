import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export const inputClass = 'mt-1 block w-full rounded border border-gray-300 px-3 py-2'
export const buttonClass = 'rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium text-gray-700">
      {label}
      {children}
    </label>
  )
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-red-700">
      {error}
    </p>
  ) : null
}

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
