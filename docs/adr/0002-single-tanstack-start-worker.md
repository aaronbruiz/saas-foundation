# ADR-0002: One TanStack Start Worker on Workers Static Assets

Status: Accepted · Date: 2026-09-27

## Context

Options were Pages + API Worker, Next.js via OpenNext or vinext, a web Worker + Hono API Worker, or a single full-stack Worker.

## Decision

One deployable Worker (`apps/web`) serves static assets, SSR, server functions and server routes, built with TanStack Start and `@cloudflare/vite-plugin` (`main: @tanstack/react-start/server-entry`). No Cloudflare Pages. The code is a modular monolith. Worker placement is `aws:us-east-1` (next to Neon); static assets are still served at the edge.

Extract another Worker (via `WorkerEntrypoint` + service binding) only when a trigger fires:

- heavy async compute → queue consumer / Workflow
- public developer API or high-volume webhooks → separate Worker (Hono allowed)
- special CPU/memory needs
- real-time coordination → Durable Objects

## Consequences

- One config, one preview, in-process module calls.
- Module boundaries are enforced by lint, not by deployment.
- TanStack Start has a smaller hiring pool than Next.js.
