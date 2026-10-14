CREATE TABLE "organisation_invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"user_id" text,
	"email" text,
	"code_hash" text,
	"invited_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "organisation_invitation_recipient" CHECK (("user_id" is null) <> ("email" is null)),
	CONSTRAINT "organisation_invitation_code" CHECK (("email" is null) = ("code_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "organisation_membership" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organisation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_membership_organisation_user" UNIQUE("organisation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organisation_profile" (
	"organisation_id" uuid,
	"user_id" text,
	"display_name" text NOT NULL,
	CONSTRAINT "organisation_profile_pkey" PRIMARY KEY("organisation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organisation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "device_code" ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "device_code" ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_invitation_organisation_user" ON "organisation_invitation" ("organisation_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_invitation_organisation_email" ON "organisation_invitation" ("organisation_id",lower("email"));--> statement-breakpoint
CREATE INDEX "organisation_invitation_user_idx" ON "organisation_invitation" ("user_id");--> statement-breakpoint
CREATE INDEX "organisation_membership_user_idx" ON "organisation_membership" ("user_id");--> statement-breakpoint
CREATE INDEX "organisation_profile_user_idx" ON "organisation_profile" ("user_id");--> statement-breakpoint
ALTER TABLE "organisation_invitation" ADD CONSTRAINT "organisation_invitation_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_invitation" ADD CONSTRAINT "organisation_invitation_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_invitation" ADD CONSTRAINT "organisation_invitation_invited_by_user_id_fkey" FOREIGN KEY ("invited_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "organisation_membership" ADD CONSTRAINT "organisation_membership_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_membership" ADD CONSTRAINT "organisation_membership_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organisation_profile" ADD CONSTRAINT "organisation_profile_membership_fk" FOREIGN KEY ("organisation_id","user_id") REFERENCES "organisation_membership"("organisation_id","user_id") ON DELETE CASCADE;