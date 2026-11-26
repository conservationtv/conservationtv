-- `customcams` is no longer a standard command: `slots` sets the layout instead. What was set or taken of it goes, and an
-- organisation's own command used by `slots` goes too, since that word is now a standard command's.
DELETE FROM "chat_command_setting" WHERE "command" = 'customcams';--> statement-breakpoint
DELETE FROM "chat_command_turn" WHERE "command" = 'customcams';--> statement-breakpoint
DELETE FROM "chat_command" WHERE "name" = 'slots';--> statement-breakpoint
ALTER TABLE "chat_command_setting" DROP CONSTRAINT "chat_command_setting_command", ADD CONSTRAINT "chat_command_setting_command" CHECK (command in ('ptzhome', 'ptzload', 'ptzlist', 'ptzpan', 'ptztilt', 'ptzzoom', 'ptzset', 'ptzseta', 'ptzmove', 'ptzcenter', 'ptzfocusa', 'swap', 'slots', 'scenecams', 'takeover', 'livecams', 'mute', 'unmute', 'setvolume', 'getvolume', 'resetvolume'));