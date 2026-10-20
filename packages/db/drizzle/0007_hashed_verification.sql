CREATE OR REPLACE FUNCTION archive.audit_auth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  r jsonb := coalesce(n, to_jsonb(OLD));
  p jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  owner_key text := CASE TG_TABLE_NAME WHEN 'user' THEN 'id' ELSE 'user_id' END;
  uid text := r->>owner_key;
  prev_uid text := p->>owner_key;
  d jsonb;
BEGIN
  IF TG_TABLE_NAME = 'verification' THEN
    SELECT u.id INTO uid FROM public."user" u WHERE u.id = r->>'value';
    SELECT u.id INTO prev_uid FROM public."user" u WHERE u.id = p->>'value';
  END IF;
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
      'verification_id', r->>'id',
      'previous_verification_id', p->>'id',
      'expires_at', r->>'expires_at',
      'previous_expires_at', p->>'expires_at',
      'identifier_changed', CASE WHEN TG_OP = 'UPDATE' THEN p->>'identifier' IS DISTINCT FROM r->>'identifier' END,
      'value_changed', CASE WHEN TG_OP = 'UPDATE' THEN p->>'value' IS DISTINCT FROM r->>'value' END)
  END;
  INSERT INTO archive.auth_event (event, user_id, previous_user_id, organization_id, detail)
  VALUES (TG_TABLE_NAME || '.' || lower(TG_OP), uid, prev_uid, r->>'organization_id',
          jsonb_strip_nulls(d));
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_insert AFTER INSERT ON public.verification FOR EACH ROW EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_update AFTER UPDATE ON public.verification FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.identifier IS DISTINCT FROM NEW.identifier
        OR OLD.value IS DISTINCT FROM NEW.value OR OLD.expires_at IS DISTINCT FROM NEW.expires_at)
  EXECUTE FUNCTION archive.audit_auth();--> statement-breakpoint
REVOKE DELETE ON TABLE public.account FROM app_runtime;