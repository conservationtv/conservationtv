CREATE TABLE "agent_signing_key" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"algorithm" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "agent_signing_key_algorithm" CHECK ("algorithm" in ('Ed25519'))
);
--> statement-breakpoint
CREATE TABLE "observation" (
	"organisation_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"reporter_id" uuid NOT NULL,
	"subject_id" text NOT NULL,
	"key_id" uuid NOT NULL,
	"observed_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reporter_opinion" (
	"organisation_id" uuid NOT NULL,
	"subject_id" text,
	"reporter_id" uuid,
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
	"contributing_reporter_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"evidence_report_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "subject_state_pkey" PRIMARY KEY("organisation_id","subject_id"),
	CONSTRAINT "subject_state_health" CHECK ("health" in ('healthy', 'unhealthy', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "metric_sample" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"subject_id" text NOT NULL,
	"key_id" uuid NOT NULL,
	"observed_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"unit" text,
	"dimensions" jsonb DEFAULT '{}' NOT NULL,
	"value" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_record" (
	"organisation_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"reporter_id" uuid NOT NULL,
	"subject_id" text NOT NULL,
	"key_id" uuid NOT NULL,
	"observed_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_signing_key_agent_idx" ON "agent_signing_key" ("agent_id");--> statement-breakpoint
CREATE INDEX "observation_subject_observed_idx" ON "observation" ("organisation_id","subject_id","observed_at");--> statement-breakpoint
CREATE INDEX "metric_sample_subject_observed_idx" ON "metric_sample" ("organisation_id","subject_id","observed_at");--> statement-breakpoint
CREATE INDEX "log_record_subject_observed_idx" ON "log_record" ("organisation_id","subject_id","observed_at");--> statement-breakpoint
ALTER TABLE "agent_signing_key" ADD CONSTRAINT "agent_signing_key_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_signing_key" ADD CONSTRAINT "agent_signing_key_agent_fk" FOREIGN KEY ("organisation_id","agent_id") REFERENCES "agent"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_key_id_agent_signing_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "agent_signing_key"("id");--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_reporter_fk" FOREIGN KEY ("organisation_id","reporter_id") REFERENCES "agent"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reporter_opinion" ADD CONSTRAINT "reporter_opinion_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reporter_opinion" ADD CONSTRAINT "reporter_opinion_reporter_fk" FOREIGN KEY ("organisation_id","reporter_id") REFERENCES "agent"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subject_state" ADD CONSTRAINT "subject_state_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "metric_sample" ADD CONSTRAINT "metric_sample_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "metric_sample" ADD CONSTRAINT "metric_sample_key_id_agent_signing_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "agent_signing_key"("id");--> statement-breakpoint
ALTER TABLE "metric_sample" ADD CONSTRAINT "metric_sample_reporter_fk" FOREIGN KEY ("organisation_id","reporter_id") REFERENCES "agent"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "log_record" ADD CONSTRAINT "log_record_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "log_record" ADD CONSTRAINT "log_record_key_id_agent_signing_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "agent_signing_key"("id");--> statement-breakpoint
ALTER TABLE "log_record" ADD CONSTRAINT "log_record_reporter_fk" FOREIGN KEY ("organisation_id","reporter_id") REFERENCES "agent"("organisation_id","id") ON DELETE CASCADE;