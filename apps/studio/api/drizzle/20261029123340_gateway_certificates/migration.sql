CREATE TABLE "gateway_certificate" (
	"organisation_id" uuid NOT NULL,
	"gateway_id" uuid PRIMARY KEY,
	"hostname" text NOT NULL CONSTRAINT "gateway_certificate_hostname" UNIQUE,
	"private_key" bytea NOT NULL,
	"certificate" text,
	"not_after" timestamp,
	"issued_at" timestamp,
	"attempted_at" timestamp,
	"error" text,
	"address" inet,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gateway_certificate" ADD CONSTRAINT "gateway_certificate_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "gateway_certificate" ADD CONSTRAINT "gateway_certificate_gateway_fk" FOREIGN KEY ("organisation_id","gateway_id") REFERENCES "gateway"("organisation_id","id") ON DELETE CASCADE;