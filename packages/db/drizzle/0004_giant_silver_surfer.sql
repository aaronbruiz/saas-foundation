ALTER TABLE "billing_subscription" DROP CONSTRAINT "billing_subscription_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "billing_subscription" ADD CONSTRAINT "billing_subscription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;