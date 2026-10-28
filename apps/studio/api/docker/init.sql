-- The application role request sessions log in as: no superuser, no BYPASSRLS, and not the owner of any table, so
-- row-level security applies to everything it does. Locally it logs in as `studio_app` itself, which the
-- application_role migration then finds and keeps; its privileges are granted by the migrations in drizzle/.
create role studio_app login password 'studio_app';
