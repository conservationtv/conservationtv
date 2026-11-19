CREATE TABLE "audit_entry" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"operation_id" text NOT NULL,
	"operation_version" integer,
	"category" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"session_id" text,
	"device_kind" text,
	"targets" jsonb DEFAULT '{}' NOT NULL,
	"fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"access_changes" jsonb DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_entry_organisation_occurred_idx" ON "audit_entry" ("organisation_id","occurred_at");--> statement-breakpoint
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id");