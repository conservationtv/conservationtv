ALTER TABLE "exposure" DROP CONSTRAINT "exposure_gateway_fk";--> statement-breakpoint
ALTER TABLE "exposure" ALTER COLUMN "gateway_id" SET DATA TYPE text USING "gateway_id"::text;