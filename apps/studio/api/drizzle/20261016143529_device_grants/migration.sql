-- Every device is a principal of its organisation, granted the shared `organisationDevice` role there for exactly as
-- long as it exists (src/db/roles.ts): it reads the organisation's devices, for iroh allowlists. Triggers keep the
-- grant with the row, in the same transaction, however the device is created or deleted (agents, cameras, browsers,
-- and cascades). They write umbrella's grants table directly, in the form `access.grant` stores a shared role, and run
-- as the owner, since request sessions may not write grants.
create function "grant_device_principal"() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  insert into "authz_role_assignments" ("principal_kind", "principal_id", "resource", "role", "scope_name", "scope_id")
  values ('device', new."id"::text, '@shared', 'organisationDevice', 'organisation', new."organisation_id"::text)
  on conflict do nothing;
  return null;
end
$$;
--> statement-breakpoint
create trigger "device_grant" after insert on "device" for each row execute function "grant_device_principal"();
--> statement-breakpoint
create function "revoke_device_principal"() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  delete from "authz_role_assignments" where "principal_kind" = 'device' and "principal_id" = old."id"::text;
  return null;
end
$$;
--> statement-breakpoint
create trigger "device_revoke" after delete on "device" for each row execute function "revoke_device_principal"();
