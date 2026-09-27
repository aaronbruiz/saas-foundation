# Runbooks

Planned: deploy & rollback, migrations, Neon point-in-time restore, preview cleanup.

## Pre-production checklist (from ADR-0003)

- [ ] Neon org upgraded to Launch; restore window set to 7 days (currently capped at 6 h on Free)
- [ ] Production compute scale-to-zero disabled (not permitted on Free)
- [ ] Restore rehearsed once: PITR → new branch → verify → repoint the Hyperdrive config
