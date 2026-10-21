ALTER TABLE "camera" ADD COLUMN "credentials" bytea;--> statement-breakpoint
ALTER TABLE "camera" ALTER COLUMN "settings" DROP DEFAULT;