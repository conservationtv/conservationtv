CREATE TABLE "cloudflare_moq_relay" (
	"organisation_id" uuid NOT NULL,
	"gateway_id" uuid PRIMARY KEY,
	"relay_id" text NOT NULL,
	"publish_token" bytea,
	"publish_expires_at" timestamp,
	"subscribe_token" bytea,
	"subscribe_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloudflare_moq_relay" ADD CONSTRAINT "cloudflare_moq_relay_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cloudflare_moq_relay" ADD CONSTRAINT "cloudflare_moq_relay_gateway_fk" FOREIGN KEY ("organisation_id","gateway_id") REFERENCES "gateway"("organisation_id","id") ON DELETE CASCADE;