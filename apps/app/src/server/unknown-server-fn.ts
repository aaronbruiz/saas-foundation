// TanStack Start's server-function resolver throws a plain Error for an id that isn't a
// client-callable server function, and the framework answers it with a logged 500 (an alert,
// ADR-0031). The messages are the only signal it exposes (@tanstack/start-server-core 1.169):
// production build, dev server, and an id that exists but isn't referenced by the client.
const UNKNOWN_SERVER_FN = [
  /^Server function info not found for /,
  /^Invalid server function ID: /,
  /^Server function not accessible from client: /,
]

export function isUnknownServerFnError(e: unknown): boolean {
  return e instanceof Error && UNKNOWN_SERVER_FN.some((m) => m.test(e.message))
}

/**
 * The production resolver looks ids up in a plain object, so an id named like an Object.prototype
 * member (`constructor`, `__proto__`, `toString`…) finds an inherited value and fails with an
 * unmatched TypeError instead. Such an id is never a server function: answer it before resolution.
 * The id is the first path segment after TanStack's default base, `/_serverFn/`.
 */
export function isUnknownServerFnPath(pathname: string): boolean {
  const id = pathname.slice('/_serverFn/'.length).split('/')[0]
  return id !== '' && id in Object.prototype
}
