CREATE TABLE "subject_transition" (
	"organisation_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject_id" text NOT NULL,
	"at" timestamp NOT NULL,
	"health" text NOT NULL,
	"activity" text NOT NULL,
	"previous_health" text,
	"previous_activity" text,
	"findings" jsonb NOT NULL,
	CONSTRAINT "subject_transition_health" CHECK ("health" in ('healthy', 'degraded', 'unhealthy', 'unknown')),
	CONSTRAINT "subject_transition_activity" CHECK ("activity" in ('active', 'idle', 'off'))
);
--> statement-breakpoint
ALTER TABLE "reporter_opinion" ADD COLUMN "activity" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "subject_state" ADD COLUMN "activity" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX "subject_transition_at_idx" ON "subject_transition" ("organisation_id","at");--> statement-breakpoint
CREATE INDEX "subject_transition_subject_idx" ON "subject_transition" ("organisation_id","subject_id","at");--> statement-breakpoint
ALTER TABLE "subject_transition" ADD CONSTRAINT "subject_transition_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reporter_opinion" ADD CONSTRAINT "reporter_opinion_activity" CHECK ("activity" in ('active', 'idle', 'off'));--> statement-breakpoint
ALTER TABLE "subject_state" ADD CONSTRAINT "subject_state_activity" CHECK ("activity" in ('active', 'idle', 'off'));