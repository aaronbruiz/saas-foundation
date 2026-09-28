CREATE TABLE "billing_subscription" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"provider_price_id" text,
	"plan_key" text,
	"status" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"provider_event_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscription_provider_subscription_id_unique" UNIQUE("provider_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_event" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_webhook_event_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "billing_subscription" ADD CONSTRAINT "billing_subscription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;