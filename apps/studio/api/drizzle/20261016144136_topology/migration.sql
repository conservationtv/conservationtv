CREATE TABLE "network" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "network_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"network_id" uuid,
	"public_key" text NOT NULL,
	"public_id" text NOT NULL CONSTRAINT "device_public_id" UNIQUE,
	"private_key" bytea NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_organisation_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "device_organisation_id_kind" UNIQUE("organisation_id","id","kind"),
	CONSTRAINT "device_organisation_id_kind_network" UNIQUE("organisation_id","id","kind","network_id"),
	CONSTRAINT "device_kind" CHECK (kind in ('agent', 'camera', 'browser')),
	CONSTRAINT "device_public_id_hex" CHECK ("public_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "device_browser_internet" CHECK ("kind" <> 'browser' or "network_id" is null)
);
--> statement-breakpoint
CREATE TABLE "camera" (
	"id" uuid PRIMARY KEY,
	"organisation_id" uuid NOT NULL,
	"kind" text GENERATED ALWAYS AS ('camera') STORED NOT NULL,
	"native_exposures" jsonb DEFAULT '[]' NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser" (
	"id" uuid PRIMARY KEY,
	"organisation_id" uuid NOT NULL,
	"kind" text GENERATED ALWAYS AS ('browser') STORED NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	CONSTRAINT "browser_session_organisation" UNIQUE("session_id","organisation_id")
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY,
	"organisation_id" uuid NOT NULL,
	"kind" text GENERATED ALWAYS AS ('agent') STORED NOT NULL,
	"network_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	CONSTRAINT "agent_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE TABLE "configuration_revision" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"diagnostics" jsonb DEFAULT '[]' NOT NULL,
	"has_errors" boolean GENERATED ALWAYS AS (jsonb_path_exists(diagnostics, '$[*] ? (@.severity == "error")')) STORED NOT NULL,
	"served" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "configuration_revision_served_usable" CHECK (not ("served" and "has_errors"))
);
--> statement-breakpoint
CREATE TABLE "exposure" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"stream_id" uuid NOT NULL,
	"network_id" uuid,
	"protocol" text NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "exposure_stream_id" UNIQUE("stream_id","id")
);
--> statement-breakpoint
CREATE TABLE "recorder" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"stream_id" uuid NOT NULL,
	"exposure_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stream" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_device_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stream_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE INDEX "device_network_idx" ON "device" ("network_id");--> statement-breakpoint
CREATE INDEX "browser_user_idx" ON "browser" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_network_active" ON "agent" ("network_id") WHERE "active";--> statement-breakpoint
CREATE INDEX "agent_network_idx" ON "agent" ("network_id");--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_revision_agent_served" ON "configuration_revision" ("agent_id") WHERE "served";--> statement-breakpoint
CREATE INDEX "configuration_revision_agent_idx" ON "configuration_revision" ("agent_id");--> statement-breakpoint
CREATE INDEX "exposure_network_idx" ON "exposure" ("network_id");--> statement-breakpoint
CREATE INDEX "recorder_stream_idx" ON "recorder" ("stream_id");--> statement-breakpoint
CREATE INDEX "recorder_exposure_idx" ON "recorder" ("exposure_id");--> statement-breakpoint
CREATE INDEX "stream_source_device_idx" ON "stream" ("source_device_id");--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_network_fk" FOREIGN KEY ("organisation_id","network_id") REFERENCES "network"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "camera" ADD CONSTRAINT "camera_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "camera" ADD CONSTRAINT "camera_device_fk" FOREIGN KEY ("organisation_id","id","kind") REFERENCES "device"("organisation_id","id","kind");--> statement-breakpoint
ALTER TABLE "browser" ADD CONSTRAINT "browser_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "browser" ADD CONSTRAINT "browser_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id");--> statement-breakpoint
ALTER TABLE "browser" ADD CONSTRAINT "browser_device_fk" FOREIGN KEY ("organisation_id","id","kind") REFERENCES "device"("organisation_id","id","kind");--> statement-breakpoint
ALTER TABLE "browser" ADD CONSTRAINT "browser_membership_fk" FOREIGN KEY ("organisation_id","user_id") REFERENCES "organisation_membership"("organisation_id","user_id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_device_fk" FOREIGN KEY ("organisation_id","id","kind","network_id") REFERENCES "device"("organisation_id","id","kind","network_id");--> statement-breakpoint
ALTER TABLE "configuration_revision" ADD CONSTRAINT "configuration_revision_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "configuration_revision" ADD CONSTRAINT "configuration_revision_agent_fk" FOREIGN KEY ("organisation_id","agent_id") REFERENCES "agent"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_stream_fk" FOREIGN KEY ("organisation_id","stream_id") REFERENCES "stream"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_network_fk" FOREIGN KEY ("organisation_id","network_id") REFERENCES "network"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_stream_fk" FOREIGN KEY ("organisation_id","stream_id") REFERENCES "stream"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_exposure_fk" FOREIGN KEY ("stream_id","exposure_id") REFERENCES "exposure"("stream_id","id");--> statement-breakpoint
ALTER TABLE "stream" ADD CONSTRAINT "stream_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stream" ADD CONSTRAINT "stream_source_device_fk" FOREIGN KEY ("organisation_id","source_device_id") REFERENCES "device"("organisation_id","id");