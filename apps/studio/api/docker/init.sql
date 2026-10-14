-- The application role request sessions log in as: no superuser, no BYPASSRLS, and not the owner of any table, so
-- row-level security applies to everything it does. Table privileges are granted by the migrations in drizzle/.
create role studio_app login password 'studio_app';
grant usage on schema public to studio_app;
