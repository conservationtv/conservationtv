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
