CREATE TYPE "public"."iroh_lease_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "assertion_replays" (
	"principal_id" text NOT NULL,
	"jti" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assertion_replays_principal_id_jti_pk" PRIMARY KEY("principal_id","jti")
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"subject" text NOT NULL,
	"assertion_jti" text NOT NULL,
	"assertion_key_id" text NOT NULL,
	"moq_root" text,
	"moq_publish" text[],
	"moq_subscribe" text[],
	"iroh_endpoint_id" text,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "iroh_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"subject" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "iroh_lease_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks_cache" (
	"jwks_uri" text PRIMARY KEY NOT NULL,
	"keys" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"fresh_until" timestamp with time zone NOT NULL,
	"stale_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iroh_leases" ADD CONSTRAINT "iroh_leases_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assertion_replays_expires_at_index" ON "assertion_replays" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "grants_principal_id_subject_index" ON "grants" USING btree ("principal_id","subject");--> statement-breakpoint
CREATE INDEX "grants_issued_at_index" ON "grants" USING btree ("issued_at");--> statement-breakpoint
CREATE INDEX "iroh_leases_endpoint_id_expires_at_index" ON "iroh_leases" USING btree ("endpoint_id","expires_at");--> statement-breakpoint
CREATE INDEX "iroh_leases_grant_id_index" ON "iroh_leases" USING btree ("grant_id");