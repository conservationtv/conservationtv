CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL CONSTRAINT "agent_subject" UNIQUE,
	"network_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
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
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL CONSTRAINT "device_subject" UNIQUE,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"network_id" uuid,
	"native_exposures" jsonb DEFAULT '[]' NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE TABLE "exposure" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"stream_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL CONSTRAINT "exposure_subject" UNIQUE,
	"network_id" uuid,
	"protocol" text NOT NULL,
	"platform_provider_id" uuid,
	"organisation_provider_id" uuid,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "exposure_stream_id" UNIQUE("stream_id","id"),
	CONSTRAINT "exposure_one_provider" CHECK (num_nonnulls("platform_provider_id", "organisation_provider_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "network" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL CONSTRAINT "network_subject" UNIQUE,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "network_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE TABLE "organisation_provider_registration" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"type_id" text NOT NULL,
	"name" text NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"credential_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_provider_registration_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE TABLE "platform_provider_registration" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"type_id" text NOT NULL,
	"name" text NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"credential_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"rate_limits" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_resource" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"platform_provider_id" uuid,
	"organisation_provider_id" uuid,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_resource_one_provider" CHECK (num_nonnulls("platform_provider_id", "organisation_provider_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "provider_type" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL
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
	"subject_id" uuid NOT NULL CONSTRAINT "stream_subject" UNIQUE,
	"name" text NOT NULL,
	"source_device_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stream_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE TABLE "subject" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subject_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_network_active" ON "agent" ("network_id") WHERE "active";--> statement-breakpoint
CREATE INDEX "agent_network_idx" ON "agent" ("network_id");--> statement-breakpoint
CREATE INDEX "agent_device_idx" ON "agent" ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_revision_agent_served" ON "configuration_revision" ("agent_id") WHERE "served";--> statement-breakpoint
CREATE INDEX "configuration_revision_agent_idx" ON "configuration_revision" ("agent_id");--> statement-breakpoint
CREATE INDEX "device_network_idx" ON "device" ("network_id");--> statement-breakpoint
CREATE INDEX "exposure_network_idx" ON "exposure" ("network_id");--> statement-breakpoint
CREATE INDEX "exposure_platform_provider_idx" ON "exposure" ("platform_provider_id");--> statement-breakpoint
CREATE INDEX "exposure_organisation_provider_idx" ON "exposure" ("organisation_provider_id");--> statement-breakpoint
CREATE INDEX "provider_resource_organisation_idx" ON "provider_resource" ("organisation_id");--> statement-breakpoint
CREATE INDEX "provider_resource_platform_provider_idx" ON "provider_resource" ("platform_provider_id");--> statement-breakpoint
CREATE INDEX "provider_resource_organisation_provider_idx" ON "provider_resource" ("organisation_provider_id");--> statement-breakpoint
CREATE INDEX "recorder_stream_idx" ON "recorder" ("stream_id");--> statement-breakpoint
CREATE INDEX "recorder_exposure_idx" ON "recorder" ("exposure_id");--> statement-breakpoint
CREATE INDEX "stream_source_device_idx" ON "stream" ("source_device_id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_subject_fk" FOREIGN KEY ("organisation_id","subject_id") REFERENCES "subject"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_network_fk" FOREIGN KEY ("organisation_id","network_id") REFERENCES "network"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_device_fk" FOREIGN KEY ("organisation_id","device_id") REFERENCES "device"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "configuration_revision" ADD CONSTRAINT "configuration_revision_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "configuration_revision" ADD CONSTRAINT "configuration_revision_agent_fk" FOREIGN KEY ("organisation_id","agent_id") REFERENCES "agent"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_subject_fk" FOREIGN KEY ("organisation_id","subject_id") REFERENCES "subject"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_network_fk" FOREIGN KEY ("organisation_id","network_id") REFERENCES "network"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_RxtxBIOVQnY7_fkey" FOREIGN KEY ("platform_provider_id") REFERENCES "platform_provider_registration"("id");--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_stream_fk" FOREIGN KEY ("organisation_id","stream_id") REFERENCES "stream"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_subject_fk" FOREIGN KEY ("organisation_id","subject_id") REFERENCES "subject"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_network_fk" FOREIGN KEY ("organisation_id","network_id") REFERENCES "network"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_organisation_provider_fk" FOREIGN KEY ("organisation_id","organisation_provider_id") REFERENCES "organisation_provider_registration"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_subject_fk" FOREIGN KEY ("organisation_id","subject_id") REFERENCES "subject"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "organisation_provider_registration" ADD CONSTRAINT "organisation_provider_registration_2Z23o2WIelBQ_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_provider_registration" ADD CONSTRAINT "organisation_provider_registration_9piu172Ytwn6_fkey" FOREIGN KEY ("type_id") REFERENCES "provider_type"("id");--> statement-breakpoint
ALTER TABLE "platform_provider_registration" ADD CONSTRAINT "platform_provider_registration_type_id_provider_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "provider_type"("id");--> statement-breakpoint
ALTER TABLE "provider_resource" ADD CONSTRAINT "provider_resource_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_resource" ADD CONSTRAINT "provider_resource_xiSDn0uHYpEK_fkey" FOREIGN KEY ("platform_provider_id") REFERENCES "platform_provider_registration"("id");--> statement-breakpoint
ALTER TABLE "provider_resource" ADD CONSTRAINT "provider_resource_organisation_provider_fk" FOREIGN KEY ("organisation_id","organisation_provider_id") REFERENCES "organisation_provider_registration"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_stream_fk" FOREIGN KEY ("organisation_id","stream_id") REFERENCES "stream"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_exposure_fk" FOREIGN KEY ("stream_id","exposure_id") REFERENCES "exposure"("stream_id","id");--> statement-breakpoint
ALTER TABLE "stream" ADD CONSTRAINT "stream_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stream" ADD CONSTRAINT "stream_subject_fk" FOREIGN KEY ("organisation_id","subject_id") REFERENCES "subject"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "stream" ADD CONSTRAINT "stream_source_device_fk" FOREIGN KEY ("organisation_id","source_device_id") REFERENCES "device"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "subject" ADD CONSTRAINT "subject_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;