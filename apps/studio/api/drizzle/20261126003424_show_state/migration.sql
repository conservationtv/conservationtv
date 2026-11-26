CREATE TABLE "show_stream" (
	"show_id" uuid,
	"stream_id" uuid,
	"organisation_id" uuid NOT NULL,
	"rank" integer,
	"volume_db" double precision DEFAULT 0 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"sync_offset_ms" integer DEFAULT 0 NOT NULL,
	"audio_stream_id" uuid,
	CONSTRAINT "show_stream_pk" PRIMARY KEY("show_id","stream_id")
);
--> statement-breakpoint
ALTER TABLE "stream" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "show" ADD COLUMN "slots" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "show" ADD COLUMN "volume_db" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "show" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "show" ADD COLUMN "takeover_stream_id" uuid;--> statement-breakpoint
ALTER TABLE "show" ADD COLUMN "takeover_live" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "output" ADD COLUMN "input_gateway_id" text;--> statement-breakpoint
ALTER TABLE "stream" ADD CONSTRAINT "stream_organisation_code" UNIQUE("organisation_id","code");--> statement-breakpoint
CREATE INDEX "show_stream_stream_idx" ON "show_stream" ("stream_id");--> statement-breakpoint
CREATE INDEX "show_stream_audio_stream_idx" ON "show_stream" ("audio_stream_id");--> statement-breakpoint
CREATE INDEX "show_stream_organisation_idx" ON "show_stream" ("organisation_id");--> statement-breakpoint
CREATE INDEX "show_takeover_stream_idx" ON "show" ("takeover_stream_id");--> statement-breakpoint
ALTER TABLE "show_stream" ADD CONSTRAINT "show_stream_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_stream" ADD CONSTRAINT "show_stream_show_fk" FOREIGN KEY ("organisation_id","show_id") REFERENCES "show"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_stream" ADD CONSTRAINT "show_stream_stream_fk" FOREIGN KEY ("organisation_id","stream_id") REFERENCES "stream"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_stream" ADD CONSTRAINT "show_stream_audio_stream_fk" FOREIGN KEY ("organisation_id","audio_stream_id") REFERENCES "stream"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "show" ADD CONSTRAINT "show_takeover_stream_fk" FOREIGN KEY ("organisation_id","takeover_stream_id") REFERENCES "stream"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "stream" ADD CONSTRAINT "stream_code" CHECK ("code" ~ '^[A-Z0-9]{1,4}$');--> statement-breakpoint
ALTER TABLE "show" ADD CONSTRAINT "show_slots" CHECK ("slots" between 0 and 6);--> statement-breakpoint
ALTER TABLE "show" ADD CONSTRAINT "show_takeover_live" CHECK ("takeover_stream_id" is not null or not "takeover_live");