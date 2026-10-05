import type { ReactNode } from 'react'
import type { LegalDocument } from './legal'

/** Public legal page: title, version and effective date, and a draft banner until it takes effect. */
export function LegalPage({ doc, children }: { doc: LegalDocument; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">{doc.title}</h1>
      <p className="mt-1 text-sm text-gray-600">
        Version {doc.version} ·{' '}
        {doc.effectiveDate ? `Effective ${doc.effectiveDate}` : 'Draft, not yet in effect'}
      </p>
      {!doc.effectiveDate && (
        <p role="note" className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          Draft: this document is incomplete and not in effect.
        </p>
      )}
      <div className="mt-6 space-y-6">{children}</div>
    </main>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  )
}

/** Marks text the owner (or their lawyer) must write. Never filled in by the codebase. */
export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-dashed border-gray-400 bg-white p-3 text-sm text-gray-600">
      <strong>Placeholder (owner/lawyer text required):</strong> {children}
    </p>
  )
}
