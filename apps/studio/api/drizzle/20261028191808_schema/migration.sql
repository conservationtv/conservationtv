CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp,
	"polling_interval" integer,
	"client_id" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "authz_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"resource" text NOT NULL,
	"role" text NOT NULL,
	"scope_name" text NOT NULL,
	"scope_id" text NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "authz_unique_grant" UNIQUE NULLS NOT DISTINCT("principal_kind","principal_id","resource","role","scope_name","scope_id","starts_at","expires_at")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisation_membership" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_membership_organisation_user" UNIQUE("organisation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organisation_profile" (
	"organisation_id" uuid,
	"user_id" text,
	"display_name" text NOT NULL,
	CONSTRAINT "organisation_profile_pkey" PRIMARY KEY("organisation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organisation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "organisation_invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"user_id" text,
	"email" text,
	"code_hash" text,
	"invited_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "organisation_invitation_recipient" CHECK (("user_id" is null) <> ("email" is null)),
	CONSTRAINT "organisation_invitation_code" CHECK (("email" is null) = ("code_hash" is null))
);
--> statement-breakpoint
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
CREATE TABLE "device_address" (
	"organisation_id" uuid NOT NULL,
	"device_id" uuid,
	"address" inet,
	"interface" text NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_address_pkey" PRIMARY KEY("device_id","address")
);
--> statement-breakpoint
CREATE TABLE "camera" (
	"id" uuid PRIMARY KEY,
	"organisation_id" uuid NOT NULL,
	"kind" text GENERATED ALWAYS AS ('camera') STORED NOT NULL,
	"settings" jsonb NOT NULL,
	"credentials" bytea
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
CREATE TABLE "gateway" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"network_id" uuid,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE TABLE "exposure" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"stream_id" uuid NOT NULL,
	"gateway_id" text NOT NULL,
	"renditions" text[] DEFAULT '{default}'::text[] NOT NULL,
	"publisher_device_id" uuid,
	"upstream_exposure_id" uuid,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "exposure_stream_id" UNIQUE("stream_id","id"),
	CONSTRAINT "exposure_upstream_other" CHECK ("upstream_exposure_id" <> "id")
);
--> statement-breakpoint
CREATE TABLE "recorder" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"stream_id" uuid NOT NULL,
	"exposure_id" uuid NOT NULL,
	"rendition" text DEFAULT 'default' NOT NULL,
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
CREATE TABLE "observation" (
	"organisation_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"reporter_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"observed_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reporter_opinion" (
	"organisation_id" uuid NOT NULL,
	"subject_id" text,
	"reporter_id" text,
	"health" text NOT NULL,
	"state" jsonb DEFAULT '{}' NOT NULL,
	"observed_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"evidence_report_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "reporter_opinion_pkey" PRIMARY KEY("subject_id","reporter_id"),
	CONSTRAINT "reporter_opinion_health" CHECK ("health" in ('healthy', 'unhealthy', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "subject_state" (
	"organisation_id" uuid,
	"subject_id" text,
	"health" text NOT NULL,
	"state" jsonb DEFAULT '{}' NOT NULL,
	"observed_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"computed_at" timestamp NOT NULL,
	"contributing_reporter_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence_report_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "subject_state_pkey" PRIMARY KEY("organisation_id","subject_id"),
	CONSTRAINT "subject_state_health" CHECK ("health" in ('healthy', 'unhealthy', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "metric_point" (
	"series_id" uuid,
	"organisation_id" uuid NOT NULL,
	"observed_at" timestamp with time zone,
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"avg" double precision NOT NULL,
	"last" double precision NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "metric_point_pkey" PRIMARY KEY("series_id","observed_at")
);
--> statement-breakpoint
CREATE TABLE "metric_series" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"subject_id" text NOT NULL,
	"name" text NOT NULL,
	"reporter_id" text NOT NULL,
	"unit" text,
	"dimensions" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_series_identity" UNIQUE NULLS NOT DISTINCT("organisation_id","subject_id","name","reporter_id","unit","dimensions"),
	CONSTRAINT "metric_series_organisation_id" UNIQUE("organisation_id","id")
);
--> statement-breakpoint
CREATE TABLE "log_record" (
	"organisation_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"reporter_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"observed_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "device_code" ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "device_code" ("user_code");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" ("credential_id");--> statement-breakpoint
CREATE INDEX "authz_principal_lookup" ON "authz_role_assignments" ("principal_kind","principal_id","resource","role");--> statement-breakpoint
CREATE INDEX "authz_scope_lookup" ON "authz_role_assignments" ("scope_name","scope_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE INDEX "organisation_membership_user_idx" ON "organisation_membership" ("user_id");--> statement-breakpoint
CREATE INDEX "organisation_profile_user_idx" ON "organisation_profile" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_invitation_organisation_user" ON "organisation_invitation" ("organisation_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_invitation_organisation_email" ON "organisation_invitation" ("organisation_id",lower("email"));--> statement-breakpoint
CREATE INDEX "organisation_invitation_user_idx" ON "organisation_invitation" ("user_id");--> statement-breakpoint
CREATE INDEX "device_network_idx" ON "device" ("network_id");--> statement-breakpoint
CREATE INDEX "browser_user_idx" ON "browser" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_network_active" ON "agent" ("network_id") WHERE "active";--> statement-breakpoint
CREATE INDEX "agent_network_idx" ON "agent" ("network_id");--> statement-breakpoint
CREATE INDEX "gateway_network_idx" ON "gateway" ("network_id");--> statement-breakpoint
CREATE INDEX "exposure_gateway_idx" ON "exposure" ("gateway_id");--> statement-breakpoint
CREATE INDEX "exposure_publisher_device_idx" ON "exposure" ("publisher_device_id");--> statement-breakpoint
CREATE INDEX "exposure_upstream_idx" ON "exposure" ("upstream_exposure_id");--> statement-breakpoint
CREATE INDEX "recorder_stream_idx" ON "recorder" ("stream_id");--> statement-breakpoint
CREATE INDEX "recorder_exposure_idx" ON "recorder" ("exposure_id");--> statement-breakpoint
CREATE INDEX "stream_source_device_idx" ON "stream" ("source_device_id");--> statement-breakpoint
CREATE INDEX "observation_subject_observed_idx" ON "observation" ("organisation_id","subject_id","observed_at");--> statement-breakpoint
CREATE INDEX "log_record_subject_observed_idx" ON "log_record" ("organisation_id","subject_id","observed_at");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_membership" ADD CONSTRAINT "organisation_membership_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_membership" ADD CONSTRAINT "organisation_membership_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_profile" ADD CONSTRAINT "organisation_profile_membership_fk" FOREIGN KEY ("organisation_id","user_id") REFERENCES "organisation_membership"("organisation_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_invitation" ADD CONSTRAINT "organisation_invitation_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_invitation" ADD CONSTRAINT "organisation_invitation_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_invitation" ADD CONSTRAINT "organisation_invitation_invited_by_user_id_fkey" FOREIGN KEY ("invited_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_network_fk" FOREIGN KEY ("organisation_id","network_id") REFERENCES "network"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "device_address" ADD CONSTRAINT "device_address_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device_address" ADD CONSTRAINT "device_address_device_fk" FOREIGN KEY ("organisation_id","device_id") REFERENCES "device"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "camera" ADD CONSTRAINT "camera_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "camera" ADD CONSTRAINT "camera_device_fk" FOREIGN KEY ("organisation_id","id","kind") REFERENCES "device"("organisation_id","id","kind");--> statement-breakpoint
ALTER TABLE "browser" ADD CONSTRAINT "browser_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "browser" ADD CONSTRAINT "browser_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id");--> statement-breakpoint
ALTER TABLE "browser" ADD CONSTRAINT "browser_device_fk" FOREIGN KEY ("organisation_id","id","kind") REFERENCES "device"("organisation_id","id","kind");--> statement-breakpoint
ALTER TABLE "browser" ADD CONSTRAINT "browser_membership_fk" FOREIGN KEY ("organisation_id","user_id") REFERENCES "organisation_membership"("organisation_id","user_id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_device_fk" FOREIGN KEY ("organisation_id","id","kind","network_id") REFERENCES "device"("organisation_id","id","kind","network_id");--> statement-breakpoint
ALTER TABLE "gateway" ADD CONSTRAINT "gateway_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "gateway" ADD CONSTRAINT "gateway_network_fk" FOREIGN KEY ("organisation_id","network_id") REFERENCES "network"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_stream_fk" FOREIGN KEY ("organisation_id","stream_id") REFERENCES "stream"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_publisher_device_fk" FOREIGN KEY ("organisation_id","publisher_device_id") REFERENCES "device"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_upstream_fk" FOREIGN KEY ("stream_id","upstream_exposure_id") REFERENCES "exposure"("stream_id","id");--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_stream_fk" FOREIGN KEY ("organisation_id","stream_id") REFERENCES "stream"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recorder" ADD CONSTRAINT "recorder_exposure_fk" FOREIGN KEY ("stream_id","exposure_id") REFERENCES "exposure"("stream_id","id");--> statement-breakpoint
ALTER TABLE "stream" ADD CONSTRAINT "stream_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stream" ADD CONSTRAINT "stream_source_device_fk" FOREIGN KEY ("organisation_id","source_device_id") REFERENCES "device"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id");--> statement-breakpoint
ALTER TABLE "reporter_opinion" ADD CONSTRAINT "reporter_opinion_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_state" ADD CONSTRAINT "subject_state_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "metric_point" ADD CONSTRAINT "metric_point_series_fk" FOREIGN KEY ("organisation_id","series_id") REFERENCES "metric_series"("organisation_id","id");--> statement-breakpoint
ALTER TABLE "metric_series" ADD CONSTRAINT "metric_series_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id");--> statement-breakpoint
ALTER TABLE "log_record" ADD CONSTRAINT "log_record_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id");