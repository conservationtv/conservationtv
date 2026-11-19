ALTER TABLE "reporter_opinion" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subject_state" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "reporter_opinion" DROP CONSTRAINT "reporter_opinion_health", ADD CONSTRAINT "reporter_opinion_health" CHECK ("health" in ('healthy', 'degraded', 'unhealthy', 'unknown'));--> statement-breakpoint
ALTER TABLE "subject_state" DROP CONSTRAINT "subject_state_health", ADD CONSTRAINT "subject_state_health" CHECK ("health" in ('healthy', 'degraded', 'unhealthy', 'unknown'));