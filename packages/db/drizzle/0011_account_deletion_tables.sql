CREATE TABLE "billing_access_gate" (
	"user_id" text PRIMARY KEY NOT NULL,
	"writes_in_flight" integer DEFAULT 0 NOT NULL,
	"closed_by" text,
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_deletion" (
	"user_id" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "billing_access_gate" ADD CONSTRAINT "billing_access_gate_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;