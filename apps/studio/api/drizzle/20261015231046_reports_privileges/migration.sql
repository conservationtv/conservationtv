-- Signing keys are revoked, never deleted, so accepted reports keep the key that verified them. Administrators register
-- and revoke them in their request sessions.
grant select, insert on "agent_signing_key" to studio_app;
--> statement-breakpoint
grant update ("revoked_at") on "agent_signing_key" to studio_app;
--> statement-breakpoint
-- Reports are written by trusted ingestion once their signatures are verified, and opinions and state by the state
-- consumer: request sessions only read them.
grant select on "observation" to studio_app;
--> statement-breakpoint
grant select on "reporter_opinion" to studio_app;
--> statement-breakpoint
grant select on "subject_state" to studio_app;
--> statement-breakpoint
grant select on "metric_sample" to studio_app;
--> statement-breakpoint
grant select on "log_record" to studio_app;
