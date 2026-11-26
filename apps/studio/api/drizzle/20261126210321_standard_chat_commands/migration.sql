CREATE TABLE "output_control_channel" (
	"organisation_id" uuid NOT NULL,
	"output_id" uuid,
	"channel_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "output_control_channel_pkey" PRIMARY KEY("output_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "chat_command_setting" (
	"organisation_id" uuid,
	"command" text,
	"enabled" boolean NOT NULL,
	"audience" text NOT NULL,
	"cooldown_seconds" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_command_setting_pkey" PRIMARY KEY("organisation_id","command"),
	CONSTRAINT "chat_command_setting_command" CHECK (command in ('ptzhome', 'ptzload', 'ptzlist', 'ptzpan', 'ptztilt', 'ptzzoom', 'ptzset', 'ptzseta', 'ptzmove', 'ptzcenter', 'ptzfocusa', 'swap', 'customcams', 'scenecams', 'takeover', 'livecams', 'mute', 'unmute', 'setvolume', 'getvolume', 'resetvolume')),
	CONSTRAINT "chat_command_setting_audience" CHECK (audience in ('everyone', 'subscriber', 'vip', 'moderator', 'broadcaster')),
	CONSTRAINT "chat_command_setting_cooldown" CHECK ("cooldown_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_command_turn" (
	"organisation_id" uuid,
	"command" text,
	"target_id" uuid,
	"triggered_at" timestamp,
	CONSTRAINT "chat_command_turn_pkey" PRIMARY KEY("organisation_id","command","target_id")
);
--> statement-breakpoint
CREATE INDEX "output_control_channel_channel_idx" ON "output_control_channel" ("channel_id");--> statement-breakpoint
ALTER TABLE "output_control_channel" ADD CONSTRAINT "output_control_channel_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_control_channel" ADD CONSTRAINT "output_control_channel_output_fk" FOREIGN KEY ("organisation_id","output_id") REFERENCES "output"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "output_control_channel" ADD CONSTRAINT "output_control_channel_channel_fk" FOREIGN KEY ("organisation_id","channel_id") REFERENCES "channel"("organisation_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_command_setting" ADD CONSTRAINT "chat_command_setting_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_command_turn" ADD CONSTRAINT "chat_command_turn_organisation_id_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE;--> statement-breakpoint
-- An organisation's own commands only reply now: the cameras, the layout and the mix are the standard commands', which
-- also take the words below. Commands that did anything else, or are used by one of those words, go.
DELETE FROM "chat_command" WHERE "action"->>'kind' <> 'reply' OR "name" IN ('cc', 'ccam', 'ccamb', 'ccams', 'ccamsb', 'ccb', 'customcam', 'customcamb', 'customcambig', 'customcams', 'customcamsb', 'customcamsbig', 'getvolume', 'livecams', 'mute', 'ptzcenter', 'ptzfocusa', 'ptzhome', 'ptzlist', 'ptzload', 'ptzmove', 'ptzpan', 'ptzset', 'ptzseta', 'ptztilt', 'ptzzoom', 'resetvolume', 'scenecams', 'setvolume', 'swap', 'takeover', 'unmute');
