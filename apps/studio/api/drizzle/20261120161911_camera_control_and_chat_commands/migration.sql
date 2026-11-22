CREATE TABLE "camera_preset" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"camera_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_command" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"action" jsonb NOT NULL,
	"audience" text DEFAULT 'moderator' NOT NULL,
	"cooldown_seconds" integer DEFAULT 5 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"triggered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_command_organisation_name" UNIQUE("organisation_id","name"),
	CONSTRAINT "chat_command_audience" CHECK (audience in ('everyone', 'subscriber', 'vip', 'moderator', 'broadcaster')),
	CONSTRAINT "chat_command_cooldown" CHECK ("cooldown_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "camera" ADD COLUMN "aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "camera" ADD CONSTRAINT "camera_organisation_id" UNIQUE("organisation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "camera_preset_camera_name" ON "camera_preset" ("camera_id",lower("name"));--> statement-breakpoint
CREATE INDEX "camera_preset_organisation_idx" ON "camera_preset" ("organisation_id");--> statement-breakpoint
ALTER TABLE "camera_preset" ADD CONSTRAINT "camera_preset_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "camera_preset" ADD CONSTRAINT "camera_preset_camera_fk" FOREIGN KEY ("organisation_id","camera_id") REFERENCES "camera"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_command" ADD CONSTRAINT "chat_command_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;