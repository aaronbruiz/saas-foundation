-- ADR-0038: the least-privilege role the app connects as (migration 0005 grants its privileges and
-- skips creating it when it exists). Local-only password, not secret.
CREATE ROLE app_runtime LOGIN PASSWORD 'app_runtime' NOINHERIT;
