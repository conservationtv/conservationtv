-- The role request sessions run as, which the access-policy migrations grant to by name: no superuser, no BYPASSRLS,
-- and owner of nothing, so row-level security applies to everything it does. Nobody logs in as it. Each environment
-- makes its own login role a member: PlanetScale names the roles it creates, so the studio release grants it to the
-- stack's application role (apps/studio/infrastructure), and docker/init.sql creates a local login role of this name.
do $$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'studio_app') then
    create role studio_app nologin;
  end if;
end
$$;
--> statement-breakpoint
grant usage on schema public to studio_app;
