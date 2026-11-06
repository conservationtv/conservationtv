ALTER TABLE "camera" ADD COLUMN "state" text DEFAULT 'enabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "camera" ADD CONSTRAINT "camera_state" CHECK (state in ('enabled', 'locked', 'disabled'));