CREATE SCHEMA IF NOT EXISTS archive;--> statement-breakpoint
REVOKE ALL ON SCHEMA archive FROM PUBLIC;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS archive.deleted_row (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  txid bigint NOT NULL DEFAULT txid_current(),
  db_user text NOT NULL DEFAULT session_user,
  table_name text NOT NULL,
  organization_id text,
  row_data jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deleted_row_at_idx ON archive.deleted_row (at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deleted_row_organization_id_idx ON archive.deleted_row (organization_id);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS archive.auth_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  txid bigint NOT NULL DEFAULT txid_current(),
  db_user text NOT NULL DEFAULT session_user,
  event text NOT NULL,
  user_id text,
  previous_user_id text,
  organization_id text,
  detail jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_event_at_idx ON archive.auth_event (at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_event_user_id_idx ON archive.auth_event (user_id);--> statement-breakpoint
REVOKE ALL ON TABLE archive.deleted_row, archive.auth_event FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION archive.capture_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r jsonb := to_jsonb(OLD) - ARRAY['password', 'access_token', 'refresh_token', 'id_token'];
BEGIN
  INSERT INTO archive.deleted_row (table_name, organization_id, row_data)
  VALUES (TG_TABLE_NAME,
          CASE WHEN TG_TABLE_NAME = 'organization' THEN r->>'id' ELSE r->>'organization_id' END,
          r);
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION archive.audit_auth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  r jsonb := coalesce(n, to_jsonb(OLD));
  p jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  owner_key text := CASE TG_TABLE_NAME WHEN 'user' THEN 'id' WHEN 'verification' THEN 'value' ELSE 'user_id' END;
  d jsonb;
BEGIN
  d := CASE TG_TABLE_NAME
    WHEN 'session' THEN jsonb_build_object(
      'session_id', r->>'id',
      'previous_session_id', p->>'id',
      'token_sha256', encode(sha256(convert_to(r->>'token', 'UTF8')), 'hex'),
      'previous_token_sha256', encode(sha256(convert_to(p->>'token', 'UTF8')), 'hex'))
    WHEN 'account' THEN jsonb_build_object(
      'account_row_id', r->>'id',
      'provider_id', r->>'provider_id',
      'account_id', r->>'account_id',
      'previous_provider_id', p->>'provider_id',
      'previous_account_id', p->>'account_id',
      'password_set', r->>'password' IS NOT NULL,
      'password_changed', CASE WHEN TG_OP = 'UPDATE' THEN p->>'password' IS DISTINCT FROM r->>'password' END)
    WHEN 'user' THEN jsonb_build_object(
      'email', r->>'email',
      'previous_email', p->>'email')
    WHEN 'member' THEN jsonb_build_object(
      'member_id', r->>'id',
      'role', r->>'role',
      'previous_role', p->>'role',
      'previous_organization_id', p->>'organization_id')
    WHEN 'verification' THEN jsonb_build_object(
      'kind', 'reset-password',
      'verification_id', r->>'id',
      'expires_at', r->>'expires_at',
      'previous_expires_at', p->>'expires_at')
  END;
  INSERT INTO archive.auth_event (event, user_id, previous_user_id, organization_id, detail)
  VALUES (TG_TABLE_NAME || '.' || lower(TG_OP), r->>owner_key, p->>owner_key, r->>'organization_id',
          jsonb_strip_nulls(d));
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION archive.capture_delete(), archive.audit_auth() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER archive_delete AFTER DELETE ON public.organization FOR EACH ROW EXECUTE FUNCTION archive.capture_delete();--> statement-breakpoint
CREATE OR REPLACE TRIGGER archive_delete AFTER DELETE ON public.member FOR EACH ROW EXECUTE FUNCTION archive.capture_delete();--> statement-breakpoint
CREATE OR REPLACE TRIGGER archive_delete AFTER DELETE ON public.invitation FOR EACH ROW EXECUTE FUNCTION archive.capture_delete();--> statement-breakpoint
CREATE OR REPLACE TRIGGER archive_delete AFTER DELETE ON public.project FOR EACH ROW EXECUTE FUNCTION archive.capture_delete();--> statement-breakpoint
CREATE OR REPLACE TRIGGER archive_delete AFTER DELETE ON public.billing_subscription FOR EACH ROW EXECUTE FUNCTION archive.capture_delete();--> statement-breakpoint
CREATE OR REPLACE TRIGGER archive_delete AFTER DELETE ON public."user" FOR EACH ROW EXECUTE FUNCTION archive.capture_delete();--> statement-breakpoint
CREATE OR REPLACE TRIGGER archive_delete AFTER DELETE ON public.account FOR EACH ROW EXECUTE FUNCTION archive.capture_delete();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_insert AFTER INSERT ON public.session FOR EACH ROW EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_delete AFTER DELETE ON public.session FOR EACH ROW EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_update AFTER UPDATE ON public.session FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.token IS DISTINCT FROM NEW.token)
  EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_insert AFTER INSERT ON public.account FOR EACH ROW EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_update AFTER UPDATE ON public.account FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.password IS DISTINCT FROM NEW.password OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.provider_id IS DISTINCT FROM NEW.provider_id OR OLD.account_id IS DISTINCT FROM NEW.account_id)
  EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_update AFTER UPDATE ON public."user" FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_insert AFTER INSERT ON public.member FOR EACH ROW EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_update AFTER UPDATE ON public.member FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.role IS DISTINCT FROM NEW.role OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_insert AFTER INSERT ON public.verification FOR EACH ROW
  WHEN (NEW.identifier LIKE 'reset-password:%')
  EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_update AFTER UPDATE ON public.verification FOR EACH ROW
  WHEN (NEW.identifier LIKE 'reset-password:%'
        AND (OLD.identifier IS DISTINCT FROM NEW.identifier OR OLD.value IS DISTINCT FROM NEW.value
             OR OLD.expires_at IS DISTINCT FROM NEW.expires_at))
  EXECUTE FUNCTION archive.audit_auth();
