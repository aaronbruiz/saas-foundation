CREATE OR REPLACE FUNCTION public.billing_subscription_held_elsewhere(p_provider text, p_subscription_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  org text := pg_catalog.current_setting('app.org_id', true);
BEGIN
  IF p_provider IS NULL OR p_subscription_id IS NULL OR org IS NULL OR org = ''
     OR NOT EXISTS (SELECT FROM public.organization o WHERE o.id = org) THEN
    RAISE EXCEPTION 'billing_subscription_held_elsewhere: no valid tenant context' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT FROM public.billing_subscription s
     WHERE s.provider = p_provider AND s.provider_subscription_id = p_subscription_id
       AND s.organization_id <> org);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_subscription_held_elsewhere(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_subscription_held_elsewhere(text, text) TO app_runtime;
