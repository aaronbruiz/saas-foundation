// Replaced at build time by Vite `define` (vite.config.ts, from build-info.ts; ADR-0029 decision 4).
declare const __BUILD_INFO__: { version: string; commit: string; build: string }

/**
 * `GET /api/ping`: `{ ok, version, commit, build }`, always 200, without touching the database. For
 * an external uptime monitor: it proves DNS, TLS and that the Worker runs, while polling
 * `/api/health` would keep Neon awake (ADR-0031). Database health stays `/api/health`'s job.
 */
export const pingResponse = (): Response =>
  Response.json({ ok: true, ...__BUILD_INFO__ }, { headers: { 'cache-control': 'no-store' } })
