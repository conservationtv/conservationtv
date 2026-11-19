CREATE TABLE "output_control" (
	"output_id" uuid PRIMARY KEY,
	"organisation_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"websocket_port" integer NOT NULL,
	"websocket_password" bytea NOT NULL,
	"scene_collection" text NOT NULL,
	"input_url" text NOT NULL,
	"reported_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "output_device" (
	"output_id" uuid PRIMARY KEY,
	"organisation_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "output_forward" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"output_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "output_forward_output_channel" UNIQUE("output_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "output_preview" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"output_id" uuid NOT NULL,
	"gateway_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "output_preview_output_gateway" UNIQUE("output_id","gateway_id")
);
--> statement-breakpoint
CREATE TABLE "output_recorder" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"output_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "output_recorder_output_kind" UNIQUE("output_id","kind"),
	CONSTRAINT "output_recorder_kind" CHECK (kind in ('obs'))
);
--> statement-breakpoint
CREATE TABLE "output" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"control" text DEFAULT 'show' NOT NULL,
	"show_id" uuid,
	"width" integer DEFAULT 1920 NOT NULL,
	"height" integer DEFAULT 1080 NOT NULL,
	"fps" integer DEFAULT 30 NOT NULL,
	"bitrate_kbps" integer DEFAULT 6000 NOT NULL,
	"keyframe_seconds" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "output_organisation_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "output_control" CHECK (control in ('show', 'external')),
	CONSTRAINT "output_external_show" CHECK ("control" = 'show' or "show_id" is null)
);
--> statement-breakpoint
-- What goes out moves from the shows to outputs (docs/outputs.md), each output keeping its show's ID, so the reports
-- about its programme (`program:<id>`), forwards, previews and recorders, all keeping theirs, carry on. Every show
-- followed its organisation's one broadcast, so each output follows the show that broadcast now is.
INSERT INTO "output" ("id", "organisation_id", "name", "control", "show_id", "width", "height", "fps", "bitrate_kbps", "keyframe_seconds", "created_at")
SELECT "id", "organisation_id", "name", 'show', "organisation_id", "width", "height", "fps", "bitrate_kbps", "keyframe_seconds", "created_at" FROM "show";--> statement-breakpoint
INSERT INTO "output_device" ("output_id", "organisation_id", "device_id", "created_at")
SELECT "show_id", "organisation_id", "device_id", "created_at" FROM "show_output";--> statement-breakpoint
INSERT INTO "output_forward" ("id", "organisation_id", "output_id", "channel_id", "enabled", "created_at")
SELECT "id", "organisation_id", "show_id", "channel_id", "enabled", "created_at" FROM "show_forward";--> statement-breakpoint
INSERT INTO "output_preview" ("id", "organisation_id", "output_id", "gateway_id", "created_at")
SELECT "id", "organisation_id", "show_id", "gateway_id", "created_at" FROM "show_preview";--> statement-breakpoint
INSERT INTO "output_recorder" ("id", "organisation_id", "output_id", "kind", "params", "created_at")
SELECT "id", "organisation_id", "show_id", "kind", "params", "created_at" FROM "show_recorder";--> statement-breakpoint
-- The broadcast is the organisation's one show, with the organisation's ID: the name its object already has. Any other
-- show was only a way out, and is an output now.
INSERT INTO "show" ("id", "organisation_id", "name")
SELECT DISTINCT "organisation_id", "organisation_id", 'Broadcast' FROM "output" ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
DELETE FROM "show" WHERE "id" <> "organisation_id";
--> statement-breakpoint
CREATE INDEX "output_control_organisation_idx" ON "output_control" ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "output_device_device_idx" ON "output_device" ("device_id");--> statement-breakpoint
CREATE INDEX "output_forward_channel_idx" ON "output_forward" ("channel_id");--> statement-breakpoint
CREATE INDEX "output_preview_gateway_idx" ON "output_preview" ("gateway_id");--> statement-breakpoint
CREATE INDEX "output_show_idx" ON "output" ("show_id");--> statement-breakpoint
ALTER TABLE "output_control" ADD CONSTRAINT "output_control_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_control" ADD CONSTRAINT "output_control_output_fk" FOREIGN KEY ("organisation_id","output_id") REFERENCES "output"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_device" ADD CONSTRAINT "output_device_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_device" ADD CONSTRAINT "output_device_output_fk" FOREIGN KEY ("organisation_id","output_id") REFERENCES "output"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_device" ADD CONSTRAINT "output_device_agent_fk" FOREIGN KEY ("organisation_id","device_id") REFERENCES "agent"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_forward" ADD CONSTRAINT "output_forward_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_forward" ADD CONSTRAINT "output_forward_output_fk" FOREIGN KEY ("organisation_id","output_id") REFERENCES "output"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_forward" ADD CONSTRAINT "output_forward_channel_fk" FOREIGN KEY ("organisation_id","channel_id") REFERENCES "channel"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_preview" ADD CONSTRAINT "output_preview_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_preview" ADD CONSTRAINT "output_preview_output_fk" FOREIGN KEY ("organisation_id","output_id") REFERENCES "output"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_recorder" ADD CONSTRAINT "output_recorder_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_recorder" ADD CONSTRAINT "output_recorder_output_fk" FOREIGN KEY ("organisation_id","output_id") REFERENCES "output"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output" ADD CONSTRAINT "output_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output" ADD CONSTRAINT "output_show_fk" FOREIGN KEY ("organisation_id","show_id") REFERENCES "show"("organisation_id","id");