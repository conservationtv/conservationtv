-- The supported provider implementations. A registration configures one of these; it never adds an implementation, so
-- new types arrive with the code that supports them, by migration.
insert into "provider_type" ("id", "name") values ('cloudflare', 'Cloudflare'), ('moq', 'Media over QUIC relay');
--> statement-breakpoint
-- Request sessions manage the topology under row-level security, which decides whose rows and which actions. These
-- privileges decide which tables and columns: scope links, subjects and creation times are never updated, and inserts
-- name every column (Drizzle sends `default` for the ones left out), so insert covers the whole table.
grant select on "provider_type" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "platform_provider_registration" to studio_app;
--> statement-breakpoint
grant update ("name", "params", "credential_refs", "rate_limits") on "platform_provider_registration" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "organisation_provider_registration" to studio_app;
--> statement-breakpoint
grant update ("name", "params", "credential_refs") on "organisation_provider_registration" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "subject" to studio_app;
--> statement-breakpoint
grant update ("label") on "subject" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "network" to studio_app;
--> statement-breakpoint
grant update ("name") on "network" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "device" to studio_app;
--> statement-breakpoint
grant update ("type", "name", "network_id", "native_exposures", "settings") on "device" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "agent" to studio_app;
--> statement-breakpoint
grant update ("device_id", "priority", "active") on "agent" to studio_app;
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
grant update ("network_id", "protocol", "platform_provider_id", "organisation_provider_id", "params") on "exposure" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "recorder" to studio_app;
--> statement-breakpoint
grant update ("exposure_id", "kind", "params") on "recorder" to studio_app;
--> statement-breakpoint
grant select, insert, delete on "provider_resource" to studio_app;
--> statement-breakpoint
grant update ("params") on "provider_resource" to studio_app;
