-- A browser device lasts as long as its browser row, which goes with its auth session or its account's membership
-- (cascading foreign keys). The device row is the parent, so nothing cascades to it: this trigger deletes it. It runs
-- as the owner, since the cascades that fire it may come from Better Auth or trusted code.
create function "delete_browser_device"() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  delete from "device" where "id" = old."id";
  return null;
end
$$;
--> statement-breakpoint
create trigger "browser_device_delete" after delete on "browser" for each row execute function "delete_browser_device"();
