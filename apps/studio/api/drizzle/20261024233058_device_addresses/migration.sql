CREATE TABLE "device_address" (
	"organisation_id" uuid NOT NULL,
	"device_id" uuid,
	"address" inet,
	"interface" text NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_address_pkey" PRIMARY KEY("device_id","address")
);
--> statement-breakpoint
ALTER TABLE "device_address" ADD CONSTRAINT "device_address_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device_address" ADD CONSTRAINT "device_address_device_fk" FOREIGN KEY ("organisation_id","device_id") REFERENCES "device"("organisation_id","id") ON DELETE CASCADE;