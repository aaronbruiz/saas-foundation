DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "user" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "session", "account", "verification", "organization", "member", "invitation", "rate_limit" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "project" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "billing_subscription" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "billing_webhook_event" TO app_runtime;
