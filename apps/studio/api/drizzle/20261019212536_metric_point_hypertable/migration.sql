-- Metric points are a TimescaleDB hypertable in one-day chunks, so a time range reads only the chunks it covers and
-- old points can be dropped a chunk at a time. Only the extension's Apache-licensed features are used: PlanetScale
-- ships no others. On PlanetScale, enable the extension in the cluster's configuration before migrating.
CREATE EXTENSION IF NOT EXISTS timescaledb;--> statement-breakpoint
SELECT create_hypertable('metric_point', by_range('observed_at', INTERVAL '1 day'));
