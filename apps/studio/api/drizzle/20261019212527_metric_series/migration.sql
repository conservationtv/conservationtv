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
DROP TABLE "metric_sample";--> statement-breakpoint
ALTER TABLE "metric_point" ADD CONSTRAINT "metric_point_series_fk" FOREIGN KEY ("organisation_id","series_id") REFERENCES "metric_series"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "metric_series" ADD CONSTRAINT "metric_series_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;