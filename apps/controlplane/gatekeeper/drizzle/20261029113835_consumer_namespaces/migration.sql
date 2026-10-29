DROP INDEX "grants_subject_index";--> statement-breakpoint
-- Grants recorded before namespaces get the empty namespace, which no consumer can have.
ALTER TABLE "grants" ADD COLUMN "namespace" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "grants" ALTER COLUMN "namespace" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "grants_namespace_subject_index" ON "grants" ("namespace","subject");
