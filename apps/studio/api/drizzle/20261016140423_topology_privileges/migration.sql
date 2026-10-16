-- Request sessions manage the topology under row-level security, which decides whose rows and which actions. These
-- privileges decide which tables and columns: scope links and creation times are never updated, and inserts
-- name every column (Drizzle sends `default` for the ones left out), so insert covers the whole table.
grant select, insert, delete on "network" to studio_app;
--> statement-breakpoint
grant update ("name") on "network" to studio_app;
--> statement-breakpoint
-- A device's private key is written once, when it is created, and never read back in a request session. Its kind and
-- identity never change.
grant select ("id", "organisation_id", "kind", "name", "network_id", "public_key", "public_id", "created_at") on "device" to studio_app;
--> statement-breakpoint
grant insert, delete on "device" to studio_app;
--> statement-breakpoint
grant update ("name", "network_id") on "device" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "camera" to studio_app;
--> statement-breakpoint
grant update ("native_exposures", "settings") on "camera" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "agent" to studio_app;
--> statement-breakpoint
-- An agent stays its device, on its network: only its standby preference and whether it is active change.
grant update ("priority", "active") on "agent" to studio_app;
--> statement-breakpoint
-- Candidates never change: only which one is served.
grant select, insert on "configuration_revision" to studio_app;
--> statement-breakpoint
grant update ("served") on "configuration_revision" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "stream" to studio_app;
--> statement-breakpoint
grant update ("name", "source_device_id") on "stream" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "exposure" to studio_app;
--> statement-breakpoint
grant update ("network_id", "protocol", "params") on "exposure" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "recorder" to studio_app;
--> statement-breakpoint
grant update ("exposure_id", "kind", "params") on "recorder" to studio_app;
