CREATE TABLE "gateway" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"network_id" uuid,
	"protocols" text[] NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_organisation_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "gateway_protocols" CHECK (cardinality("protocols") > 0)
);
--> statement-breakpoint
ALTER TABLE "exposure" DROP CONSTRAINT "exposure_network_fk";--> statement-breakpoint
DROP TABLE "configuration_revision";--> statement-breakpoint
DROP INDEX "exposure_network_idx";--> statement-breakpoint
ALTER TABLE "exposure" ADD COLUMN "gateway_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "exposure" ADD COLUMN "publisher_device_id" uuid;--> statement-breakpoint
ALTER TABLE "exposure" ADD COLUMN "upstream_exposure_id" uuid;--> statement-breakpoint
ALTER TABLE "exposure" DROP COLUMN "network_id";--> statement-breakpoint
CREATE INDEX "gateway_network_idx" ON "gateway" ("network_id");--> statement-breakpoint
CREATE INDEX "exposure_gateway_idx" ON "exposure" ("gateway_id");--> statement-breakpoint
CREATE INDEX "exposure_publisher_device_idx" ON "exposure" ("publisher_device_id");--> statement-breakpoint
CREATE INDEX "exposure_upstream_idx" ON "exposure" ("upstream_exposure_id");--> statement-breakpoint
ALTER TABLE "gateway" ADD CONSTRAINT "gateway_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "gateway" ADD CONSTRAINT "gateway_network_fk" FOREIGN KEY ("organisation_id","network_id") REFERENCES "network"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_publisher_device_fk" FOREIGN KEY ("organisation_id","publisher_device_id") REFERENCES "device"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_upstream_fk" FOREIGN KEY ("stream_id","upstream_exposure_id") REFERENCES "exposure"("stream_id","id");--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_upstream_other" CHECK ("upstream_exposure_id" <> "id");