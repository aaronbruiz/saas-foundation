import { useCallback, useEffect, useRef, useState } from 'react'

// ADR-0025: Cloudflare Turnstile widget for the auth forms. The token goes to Better Auth in the
// `x-captcha-response` header (never in a URL); tokens are single-use, so the widget resets after
// every submit.

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
    },
  ) => string
  reset: (id: string) => void
  remove: (id: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<TurnstileApi> | undefined

function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT
    script.async = true
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile'))
    script.onerror = () => {
      loading = undefined
      reject(new Error('turnstile'))
    }
    document.head.appendChild(script)
  })
  return loading
}

/**
 * Renders the widget for `siteKey` (null: bot protection unavailable, no widget). `token` is set
 * once the visitor passes and cleared when it expires or errors; `reset()` asks for a fresh one.
 */
export function useTurnstile(siteKey: string | null) {
  const container = useRef<HTMLDivElement>(null)
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!siteKey) return
    let cancelled = false
    loadTurnstile().then(
      (api) => {
        if (cancelled || !container.current) return
        const id = api.render(container.current, {
          sitekey: siteKey,
          callback: setToken,
          'expired-callback': () => setToken(null),
          'error-callback': () => setToken(null),
        })
        widget.current = { api, id }
      },
      () => !cancelled && setFailed(true),
    )
    return () => {
      cancelled = true
      if (widget.current) widget.current.api.remove(widget.current.id)
      widget.current = null
    }
  }, [siteKey])

  const reset = useCallback(() => {
    setToken(null)
    if (widget.current) widget.current.api.reset(widget.current.id)
  }, [])

  const unavailable = !siteKey || failed
  const element = (
    <>
      <div ref={container} />
      {unavailable && (
        <p role="alert" className="text-sm text-red-600">
          Bot check unavailable. Reload the page or try again later.
        </p>
      )}
    </>
  )
  return { element, token, reset, headers: token ? { 'x-captcha-response': token } : undefined }
}
