GRANT SELECT, INSERT, UPDATE ON TABLE "billing_checkout_gate" TO app_runtime;--> statement-breakpoint
CREATE OR REPLACE TRIGGER archive_delete AFTER DELETE ON public.billing_checkout_gate FOR EACH ROW EXECUTE FUNCTION archive.capture_delete();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.member_keeps_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'changing an owner needs READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM public.organization o WHERE o.id = OLD.organization_id FOR NO KEY UPDATE;
  IF FOUND AND NOT EXISTS (
    SELECT FROM public.member m
     WHERE m.organization_id = OLD.organization_id
       AND 'owner' = ANY (pg_catalog.string_to_array(pg_catalog.replace(m.role, ' ', ''), ','))
  ) THEN
    RAISE EXCEPTION 'organization would have no owner'
      USING ERRCODE = '23514', CONSTRAINT = 'member_keeps_owner';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.member_keeps_owner() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER member_keeps_owner AFTER UPDATE OR DELETE ON public.member
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ('owner' = ANY (pg_catalog.string_to_array(pg_catalog.replace(OLD.role, ' ', ''), ',')))
  EXECUTE FUNCTION public.member_keeps_owner();
