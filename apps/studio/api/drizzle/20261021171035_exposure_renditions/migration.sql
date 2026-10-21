ALTER TABLE "gateway" DROP CONSTRAINT "gateway_protocols";--> statement-breakpoint
ALTER TABLE "exposure" ADD COLUMN "renditions" text[] DEFAULT '{default}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "recorder" ADD COLUMN "rendition" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "exposure" DROP COLUMN "protocol";--> statement-breakpoint
ALTER TABLE "gateway" DROP COLUMN "protocols";