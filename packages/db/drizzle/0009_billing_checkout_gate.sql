CREATE TABLE "billing_checkout_gate" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"checkout_generation" integer DEFAULT 0 NOT NULL,
	"checkouts_in_flight" integer DEFAULT 0 NOT NULL,
	"removal_started_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "billing_checkout_gate" ADD CONSTRAINT "billing_checkout_gate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;