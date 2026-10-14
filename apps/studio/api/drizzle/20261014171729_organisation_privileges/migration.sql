-- The application role reads organisations, memberships and profiles, and edits only the names request sessions own.
-- Joining, leaving and deleting change grants too, so they are trusted code on the owning connection: no insert or
-- delete on those tables, whatever the access definitions declare.
grant select on "organisation" to studio_app;
--> statement-breakpoint
grant update ("name") on "organisation" to studio_app;
--> statement-breakpoint
grant select on "organisation_membership" to studio_app;
--> statement-breakpoint
grant select on "organisation_profile" to studio_app;
--> statement-breakpoint
grant update ("display_name") on "organisation_profile" to studio_app;
--> statement-breakpoint
-- Administrators create, list and cancel invitations in their request sessions. An emailed invitation's code hash is
-- written but never read back: only trusted code compares it. Inserts name every column (Drizzle sends `default` for
-- the ones left out), so insert covers the whole table.
grant select ("id", "organisation_id", "user_id", "email", "invited_by", "created_at", "expires_at") on "organisation_invitation" to studio_app;
--> statement-breakpoint
grant insert on "organisation_invitation" to studio_app;
--> statement-breakpoint
grant delete on "organisation_invitation" to studio_app;
