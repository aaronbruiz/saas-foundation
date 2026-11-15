# Integrations

Each external service the app depends on, in one format, so you can find its boundary, configuration, failure behaviour and tests before changing it. Rules stay in [`AGENTS.md`](../../AGENTS.md) and the ADRs; setup and recovery procedures stay in the [runbooks](../runbooks/README.md), linked from each page rather than copied. What each part of the stack is for: [architecture](../architecture/README.md#stack-and-services).

| Page                                                          | Services                                       | Decisions                                        |
| ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| [Database](database.md)                                       | Neon Postgres through Hyperdrive (`DB`)        | ADR-0003, ADR-0004, ADR-0038, ADR-0040           |
| [Identity and bot protection](identity-and-bot-protection.md) | Better Auth (in-process), Cloudflare Turnstile | ADR-0005, ADR-0014, ADR-0016, ADR-0025           |
| [Email](email.md)                                             | Cloudflare Email Service (`EMAIL`)             | ADR-0016, ADR-0024                               |
| [Billing](billing.md)                                         | Polar (merchant of record)                     | ADR-0018, ADR-0020, ADR-0022, ADR-0043, ADR-0044 |

Not covered here: GitHub Actions, R2 backups, Healthchecks.io, UptimeRobot and Workers Logs are operations, not request paths; see the runbooks.

## Page format

Every page has these sections, in this order:

1. **Responsibility**: what the service does for the app and what stays ours.
2. **Owning files**: the only places that talk to it.
3. **Configuration**: names, never values. Where each comes from and what happens when it's missing. Real values live in Worker secrets, GitHub environments or the provider's dashboard (runbooks), and `apps/app/.dev.vars` locally.
4. **Environments**: local, preview, production (and the provider's sandbox).
5. **Data exchanged**: categories of data crossing the boundary, never payload examples with personal data.
6. **Failures**: what the app answers when the service is down, slow, misconfigured or answers something unexpected, and the log event it writes ([`server/log.ts`](../../apps/app/src/server/log.ts), ADR-0015).
7. **Retry safety**: what a retry can duplicate, and what the app can't know.
8. **Tests and operations**: tests that prove the boundary, runbook sections.

Statements about a provider's behaviour come from the ADR that cites the provider's documentation with the date it was read, or from the installed package; a provider can change behaviour without the app changing. A version given here is the one installed when the page was written: check `pnpm-lock.yaml` for the current one.
