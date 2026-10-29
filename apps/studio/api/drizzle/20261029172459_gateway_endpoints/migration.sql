CREATE TABLE "gateway_endpoint" (
	"organisation_id" uuid NOT NULL,
	"gateway_id" uuid,
	"device_id" uuid NOT NULL,
	"protocol" text,
	"url" text NOT NULL,
	"registered_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "gateway_endpoint_pkey" PRIMARY KEY("gateway_id","protocol")
);
--> statement-breakpoint
CREATE INDEX "gateway_endpoint_device_idx" ON "gateway_endpoint" ("device_id");--> statement-breakpoint
ALTER TABLE "gateway_endpoint" ADD CONSTRAINT "gateway_endpoint_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "gateway_endpoint" ADD CONSTRAINT "gateway_endpoint_gateway_fk" FOREIGN KEY ("organisation_id","gateway_id") REFERENCES "gateway"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "gateway_endpoint" ADD CONSTRAINT "gateway_endpoint_device_fk" FOREIGN KEY ("organisation_id","device_id") REFERENCES "device"("organisation_id","id") ON DELETE CASCADE;