GRANT SELECT, INSERT ON TABLE "user_deletion" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "billing_access_gate" TO app_runtime;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.refuse_deleted_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target text := pg_catalog.to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF target IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public."user" u WHERE u.id = target FOR KEY SHARE;
  IF EXISTS (SELECT FROM public.user_deletion d WHERE d.user_id = target) THEN
    RAISE EXCEPTION 'account is deactivated'
      USING ERRCODE = '23514', CONSTRAINT = 'user_not_deleted';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.refuse_deleted_user() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER refuse_deleted_user BEFORE INSERT OR UPDATE ON public."user"
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleted_user('id');--> statement-breakpoint
CREATE OR REPLACE TRIGGER refuse_deleted_user BEFORE INSERT OR UPDATE ON public.session
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleted_user('user_id');--> statement-breakpoint
CREATE OR REPLACE TRIGGER refuse_deleted_user BEFORE INSERT OR UPDATE ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleted_user('user_id');--> statement-breakpoint
CREATE OR REPLACE TRIGGER refuse_deleted_user BEFORE INSERT OR UPDATE ON public.member
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleted_user('user_id');--> statement-breakpoint
CREATE OR REPLACE TRIGGER refuse_deleted_user BEFORE INSERT OR UPDATE OF inviter_id ON public.invitation
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleted_user('inviter_id');--> statement-breakpoint
CREATE OR REPLACE TRIGGER refuse_deleted_user BEFORE INSERT ON public.project
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleted_user('created_by');--> statement-breakpoint
CREATE OR REPLACE TRIGGER refuse_deleted_user BEFORE INSERT OR UPDATE ON public.verification
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleted_user('value');--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.purge_deleted_account(target text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  old_email text;
BEGIN
  IF NOT EXISTS (SELECT FROM public.user_deletion d WHERE d.user_id = target AND d.purged_at IS NULL) THEN
    RAISE EXCEPTION 'no deactivated account to purge';
  END IF;
  SELECT e.detail ->> 'previous_email' INTO old_email
    FROM archive.auth_event e
   WHERE e.event = 'user.update' AND e.user_id = target AND e.detail ->> 'email' LIKE '%@deleted.invalid'
   ORDER BY e.at DESC LIMIT 1;
  DELETE FROM public."user" u WHERE u.id = target;
  DELETE FROM archive.deleted_row a
   WHERE a.row_data ->> 'email' = old_email
      OR a.row_data ->> 'user_id' = target
      OR (a.table_name = 'user' AND a.row_data ->> 'id' = target)
      OR (a.table_name = 'invitation' AND a.row_data ->> 'inviter_id' = target);
  UPDATE archive.deleted_row a
     SET row_data = pg_catalog.jsonb_set(a.row_data, '{created_by}', 'null')
   WHERE a.row_data ->> 'created_by' = target;
  DELETE FROM archive.auth_event e
   WHERE e.user_id = target OR e.previous_user_id = target
      OR e.detail ->> 'email' = old_email OR e.detail ->> 'previous_email' = old_email;
  UPDATE public.user_deletion d SET purged_at = now() WHERE d.user_id = target;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_deleted_account(text) FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.replay_account_deletion(target text, deleted timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT FROM public.user_deletion d WHERE d.user_id = target) THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public."user" u WHERE u.id = target FOR UPDATE;
  IF FOUND THEN
    INSERT INTO public.billing_access_gate AS g (user_id, closed_by, deactivated_at)
    VALUES (target, 'replay', deleted)
    ON CONFLICT (user_id) DO UPDATE SET closed_by = 'replay', deactivated_at = deleted
      WHERE g.writes_in_flight = 0 AND g.closed_by IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'billing access gate is held: resolve it first';
    END IF;
    DELETE FROM public.member m WHERE m.user_id = target;
    UPDATE public."user" u SET email = target || '@deleted.invalid' WHERE u.id = target;
    UPDATE public.account a
       SET password = NULL, access_token = NULL, refresh_token = NULL, id_token = NULL
     WHERE a.user_id = target;
    DELETE FROM public.session s WHERE s.user_id = target;
    DELETE FROM public.verification v WHERE v.value = target;
  END IF;
  INSERT INTO public.user_deletion (user_id, deleted_at) VALUES (target, deleted);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.replay_account_deletion(text, timestamptz) FROM PUBLIC;
