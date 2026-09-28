# ADR-0007: Defer Cloudflare products until a named trigger

Status: Accepted · Date: 2026-09-27

## Decision

v1 binds only Hyperdrive (plus static assets). Every other product, or any additional Worker, needs a new ADR naming the trigger that justifies it:

| Deferred             | Trigger                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Second Worker / Hono | public API, webhook volume, or isolation need                                                                     |
| KV                   | hot, rarely changing, staleness-tolerant read (never sessions or counters)                                        |
| R2                   | first file upload (pre-signed URLs, authorization first), **or** off-provider DB dumps (ADR-0003 backup option B) |
| Queues               | first non-blocking side effect (likely email)                                                                     |
| Workflows            | first durable multi-step process                                                                                  |
| Durable Objects      | real-time coordination or single-writer lock                                                                      |
| D1                   | none foreseen                                                                                                     |

## Consequences

- Previews share storage bindings with production by default, so every new binding also needs a `previews` override (AGENTS.md invariant 14).
