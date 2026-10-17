DROP TABLE "assertion_replays";--> statement-breakpoint
DROP TABLE "jwks_cache";--> statement-breakpoint
DROP INDEX "grants_principal_id_subject_index";--> statement-breakpoint
ALTER TABLE "grants" DROP COLUMN "principal_id";--> statement-breakpoint
ALTER TABLE "grants" DROP COLUMN "assertion_jti";--> statement-breakpoint
ALTER TABLE "grants" DROP COLUMN "assertion_key_id";--> statement-breakpoint
ALTER TABLE "iroh_leases" DROP COLUMN "principal_id";--> statement-breakpoint
CREATE INDEX "grants_subject_index" ON "grants" ("subject");