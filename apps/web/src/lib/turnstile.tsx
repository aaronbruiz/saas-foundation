import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

// ADR-0025: Cloudflare Turnstile widget for the auth forms. The token goes to Better Auth in the
// `x-captcha-response` header (never in a URL); tokens are single-use, so the widget resets after
// every submit.

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string
      action: string
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

export type TurnstileConfig = { siteKey: string | null; actions: Record<string, string> }

type Widget = { api: TurnstileApi; id: string }

/**
 * Owns the widget's container and, with it, the widget: rendered on mount, removed on unmount. A
 * page can drop the form (and this component) while the hook stays mounted, e.g. for a
 * confirmation view; removing the widget here keeps Turnstile from losing track of it. A layout
 * effect, so the cleanup runs before React detaches the container.
 */
function TurnstileWidget({
  siteKey,
  action,
  widget,
  setToken,
  setFailed,
}: {
  siteKey: string
  action: string
  widget: RefObject<Widget | null>
  setToken: (token: string | null) => void
  setFailed: (failed: boolean) => void
}) {
  const container = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    let cancelled = false
    loadTurnstile().then(
      (api) => {
        if (cancelled || !container.current) return
        const id = api.render(container.current, {
          sitekey: siteKey,
          action,
          callback: (t) => {
            setFailed(false)
            setToken(t)
          },
          'expired-callback': () => setToken(null),
          'error-callback': () => {
            setToken(null)
            setFailed(true)
          },
        })
        widget.current = { api, id }
      },
      () => !cancelled && setFailed(true),
    )
    return () => {
      cancelled = true
      if (widget.current) widget.current.api.remove(widget.current.id)
      widget.current = null
      setToken(null) // the token belonged to the removed widget
    }
  }, [siteKey, action, widget, setToken, setFailed])

  return <div ref={container} />
}

/**
 * Renders the widget for the auth endpoint `path` (no site key: bot protection unavailable, no
 * widget), with the action that endpoint requires. `token` is set once the visitor passes and
 * cleared when it expires or errors; `reset()` asks for a fresh one.
 */
export function useTurnstile({ siteKey, actions }: TurnstileConfig, path: string) {
  const action = actions[path]
  const widget = useRef<Widget | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const reset = useCallback(() => {
    setToken(null)
    if (widget.current) widget.current.api.reset(widget.current.id)
  }, [])

  const unavailable = !siteKey || !action || failed
  const element = (
    <>
      {siteKey && action && (
        <TurnstileWidget
          siteKey={siteKey}
          action={action}
          widget={widget}
          setToken={setToken}
          setFailed={setFailed}
        />
      )}
      {unavailable && (
        <p role="alert" className="text-sm text-red-600">
          Bot check unavailable. Reload the page or try again later.
        </p>
      )}
    </>
  )
  return { element, token, reset, headers: token ? { 'x-captcha-response': token } : undefined }
}
