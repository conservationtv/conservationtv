-- Table privileges for the application role request sessions log in as (see docker/init.sql). Row-level security,
-- installed by the access-policy migration, chooses which rows; these privileges choose which tables and columns.
-- Better Auth's tables and the grants table stay with the owner, which the policies read on the principal's behalf.
grant select on "user" to studio_app;
--> statement-breakpoint
grant update ("name", "image", "updated_at") on "user" to studio_app;
