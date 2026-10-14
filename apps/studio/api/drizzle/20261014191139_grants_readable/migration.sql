-- Request sessions may read every grant, so role listings and checks run under the caller's row-level security instead
-- of on the owning connection. A leak through this table shows who holds which role where (including the global
-- administrators), never other data; reads on the owning connection could leak everything. Writes stay with trusted
-- code: no insert, update or delete. The policy isn't named authz_*, so `umbrella generate`, which re-enables RLS on this
-- table and drops its own policies, keeps it.
create policy "grants_readable" on "authz_role_assignments" for select to studio_app using (true);
--> statement-breakpoint
grant select on "authz_role_assignments" to studio_app;
