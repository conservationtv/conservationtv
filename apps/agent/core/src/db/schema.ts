import type { MetricDimensions } from '@conservationtv/reports';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { LogProperties } from './logs.ts';

// What the agent keeps about itself on its own disk, in more detail than it ships to the studio API: every sample its
// runtimes take, and its logs. Served over the agent API (routes/metrics.ts, routes/logs.ts), and kept for as long as
// the retention allows (retention.ts).

/**
 * One line on a chart: a metric from the catalogue about a subject, with one unit and set of dimensions, such as the
 * ingest bitrate of one MediaMTX path. Made the first time a runtime records it.
 */
export const metricSeries = sqliteTable('metric_series', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /**
   * The series' identity: its subject, name, unit and dimensions, as JSON with the dimensions' keys in order. SQLite
   * counts nulls as distinct in a unique index, so the device's own series, whose subject is null, need one value.
   */
  key: text('key').notNull().unique(),
  /** What the series is about, such as `exposure:<id>`; null for the agent's own device. */
  subjectId: text('subject_id'),
  name: text('name').notNull(),
  unit: text('unit').notNull(),
  dimensions: text('dimensions', { mode: 'json' }).$type<MetricDimensions>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

/** One sample of a series, taken at `observed_at`. Its key makes a series sampled twice at once one point. */
export const metricPoints = sqliteTable(
  'metric_point',
  {
    seriesId: integer('series_id')
      .notNull()
      .references(() => metricSeries.id, { onDelete: 'cascade' }),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
    value: real('value').notNull()
  },
  t => [
    primaryKey({ columns: [t.seriesId, t.observedAt] }),
    // Retention drops the oldest points across every series.
    index('metric_point_observed_at').on(t.observedAt)
  ]
);

/** One line the agent logged, as logtape gave it to the database sink (logs.ts). */
export const logRecords = sqliteTable(
  'log_record',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
    level: text('level', { enum: ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] }).notNull(),
    /** The logger's category, joined with dots, such as `agent.mediamtx`. */
    category: text('category').notNull(),
    /** The message with its values substituted. */
    message: text('message').notNull(),
    /** The template the message was made from, the same for every line of its kind. */
    template: text('template').notNull(),
    properties: text('properties', { mode: 'json' }).$type<LogProperties>().notNull()
  },
  t => [index('log_record_recorded_at').on(t.recordedAt)]
);
