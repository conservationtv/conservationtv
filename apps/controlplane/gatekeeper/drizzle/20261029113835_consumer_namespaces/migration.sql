DROP INDEX "grants_subject_index";--> statement-breakpoint
-- Grants recorded before namespaces get the empty namespace, which no consumer can have. The default stays
-- until every environment runs a version that sets the namespace, because the version still serving omits it.
ALTER TABLE "grants" ADD COLUMN "namespace" text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE INDEX "grants_namespace_subject_index" ON "grants" ("namespace","subject");
