CREATE TABLE "personal_stream" (
	"organisation_id" uuid,
	"user_id" text,
	"device" text,
	"stream_id" uuid NOT NULL CONSTRAINT "personal_stream_stream" UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "personal_stream_pkey" PRIMARY KEY("organisation_id","user_id","device"),
	CONSTRAINT "personal_stream_device" CHECK (device in ('phone', 'computer'))
);
--> statement-breakpoint
CREATE TABLE "stream_key" (
	"stream_id" uuid PRIMARY KEY,
	"organisation_id" uuid NOT NULL,
	"key" bytea NOT NULL,
	"key_sha256" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stream_key_sha256_hex" CHECK ("key_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "personal_stream_user_idx" ON "personal_stream" ("user_id");--> statement-breakpoint
CREATE INDEX "stream_key_organisation_idx" ON "stream_key" ("organisation_id");--> statement-breakpoint
ALTER TABLE "personal_stream" ADD CONSTRAINT "personal_stream_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "personal_stream" ADD CONSTRAINT "personal_stream_stream_fk" FOREIGN KEY ("organisation_id","stream_id") REFERENCES "stream"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "personal_stream" ADD CONSTRAINT "personal_stream_membership_fk" FOREIGN KEY ("organisation_id","user_id") REFERENCES "organisation_membership"("organisation_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stream_key" ADD CONSTRAINT "stream_key_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stream_key" ADD CONSTRAINT "stream_key_stream_fk" FOREIGN KEY ("organisation_id","stream_id") REFERENCES "stream"("organisation_id","id") ON DELETE CASCADE;