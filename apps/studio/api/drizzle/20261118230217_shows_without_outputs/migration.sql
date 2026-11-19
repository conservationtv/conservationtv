DROP TABLE "show_forward";--> statement-breakpoint
DROP TABLE "show_output";--> statement-breakpoint
DROP TABLE "show_preview";--> statement-breakpoint
DROP TABLE "show_recorder";--> statement-breakpoint
ALTER TABLE "show" DROP COLUMN "width";--> statement-breakpoint
ALTER TABLE "show" DROP COLUMN "height";--> statement-breakpoint
ALTER TABLE "show" DROP COLUMN "fps";--> statement-breakpoint
ALTER TABLE "show" DROP COLUMN "bitrate_kbps";--> statement-breakpoint
ALTER TABLE "show" DROP COLUMN "keyframe_seconds";