/** Only same-site paths ("/x", never "//host" or "https://…") may be used as post-login targets. */
export const safeRedirect = (target: unknown, fallback = '/'): string =>
  typeof target === 'string' && /^\/(?!\/)/.test(target) ? target : fallback
