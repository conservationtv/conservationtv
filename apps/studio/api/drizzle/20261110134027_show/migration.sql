CREATE TABLE "show_forward" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"show_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "show_forward_show_channel" UNIQUE("show_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "show_preview" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"show_id" uuid NOT NULL,
	"gateway_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "show_preview_show_gateway" UNIQUE("show_id","gateway_id")
);
--> statement-breakpoint
CREATE TABLE "show_recorder" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"show_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "show_recorder_show_kind" UNIQUE("show_id","kind"),
	CONSTRAINT "show_recorder_kind" CHECK (kind in ('obs'))
);
--> statement-breakpoint
CREATE TABLE "show" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"width" integer DEFAULT 1920 NOT NULL,
	"height" integer DEFAULT 1080 NOT NULL,
	"fps" integer DEFAULT 30 NOT NULL,
	"bitrate_kbps" integer DEFAULT 6000 NOT NULL,
	"keyframe_seconds" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "show_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
-- Every organisation going out today has one show, its broadcast, whose ID is the organisation's: the ID each
-- `show_output.show_id` already holds. It forwards to each of the organisation's channels, as the channel was on or off.
INSERT INTO "show" ("id", "organisation_id", "name")
SELECT "show_id", "organisation_id", 'Broadcast' FROM "show_output";--> statement-breakpoint
INSERT INTO "show_forward" ("organisation_id", "show_id", "channel_id", "enabled")
SELECT "channel"."organisation_id", "show"."id", "channel"."id", "channel"."enabled"
FROM "channel" JOIN "show" ON "show"."organisation_id" = "channel"."organisation_id";--> statement-breakpoint
ALTER TABLE "channel" DROP COLUMN "enabled";--> statement-breakpoint
DROP INDEX "show_output_device_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "show_output_device_idx" ON "show_output" ("device_id");--> statement-breakpoint
CREATE INDEX "show_forward_channel_idx" ON "show_forward" ("channel_id");--> statement-breakpoint
CREATE INDEX "show_preview_gateway_idx" ON "show_preview" ("gateway_id");--> statement-breakpoint
ALTER TABLE "show_forward" ADD CONSTRAINT "show_forward_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_forward" ADD CONSTRAINT "show_forward_show_fk" FOREIGN KEY ("organisation_id","show_id") REFERENCES "show"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_forward" ADD CONSTRAINT "show_forward_channel_fk" FOREIGN KEY ("organisation_id","channel_id") REFERENCES "channel"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_output" ADD CONSTRAINT "show_output_show_fk" FOREIGN KEY ("organisation_id","show_id") REFERENCES "show"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_preview" ADD CONSTRAINT "show_preview_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_preview" ADD CONSTRAINT "show_preview_show_fk" FOREIGN KEY ("organisation_id","show_id") REFERENCES "show"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_recorder" ADD CONSTRAINT "show_recorder_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_recorder" ADD CONSTRAINT "show_recorder_show_fk" FOREIGN KEY ("organisation_id","show_id") REFERENCES "show"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show" ADD CONSTRAINT "show_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;