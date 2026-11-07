CREATE TABLE "show_output" (
	"show_id" uuid PRIMARY KEY,
	"organisation_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "show_output_device_idx" ON "show_output" ("device_id");--> statement-breakpoint
ALTER TABLE "show_output" ADD CONSTRAINT "show_output_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "show_output" ADD CONSTRAINT "show_output_agent_fk" FOREIGN KEY ("organisation_id","device_id") REFERENCES "agent"("organisation_id","id") ON DELETE CASCADE;