CREATE TABLE "channel_credential" (
	"channel_id" uuid PRIMARY KEY,
	"organisation_id" uuid NOT NULL,
	"credentials" bytea NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"external_login" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "channel_organisation_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "channel_organisation_external" UNIQUE("organisation_id","kind","external_id"),
	CONSTRAINT "channel_kind" CHECK (kind in ('twitch', 'rtmp'))
);
--> statement-breakpoint
CREATE INDEX "channel_credential_organisation_idx" ON "channel_credential" ("organisation_id");--> statement-breakpoint
CREATE INDEX "channel_organisation_idx" ON "channel" ("organisation_id");--> statement-breakpoint
ALTER TABLE "channel_credential" ADD CONSTRAINT "channel_credential_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "channel_credential" ADD CONSTRAINT "channel_credential_channel_fk" FOREIGN KEY ("organisation_id","channel_id") REFERENCES "channel"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Each show's existing output reads its organisation's channel credentials (src/services/shows.ts, syncBroadcasters).
INSERT INTO "authz_role_assignments" ("principal_kind", "principal_id", "resource", "role", "scope_name", "scope_id")
SELECT 'device', "device_id"::text, '@shared', 'channelBroadcaster', 'organisation', "organisation_id"::text
FROM "show_output"
ON CONFLICT ON CONSTRAINT "authz_unique_grant" DO NOTHING;
