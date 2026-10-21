ALTER TABLE "gateway" DROP CONSTRAINT "gateway_protocols";--> statement-breakpoint
ALTER TABLE "exposure" ADD COLUMN "renditions" text[] DEFAULT '{default}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "recorder" ADD COLUMN "rendition" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "exposure" DROP COLUMN "protocol";--> statement-breakpoint
ALTER TABLE "gateway" DROP COLUMN "protocols";--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_renditions" CHECK (cardinality("renditions") > 0 and "renditions" <@ array['default', 'data_saver', 'balanced', 'quality']::text[]);--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_rendition" CHECK ("rendition" = any(array['default', 'data_saver', 'balanced', 'quality']::text[]));