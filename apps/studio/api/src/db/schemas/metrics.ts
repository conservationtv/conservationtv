import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid
} from 'drizzle-orm/pg-core';
import type { MetricDimensions } from '../../topology/settings.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

/**
 * One line on a chart: a named metric about a subject, from one reporter, with one unit and set of dimensions, such as
 * the bitrate of one MediaMTX path. A series is made the first time a report names it, and its points follow. Two
 * reporters measuring the same thing are two series, never summed.
 */
export const metricSeries = withAccess(
  pgTable(
    'metric_series',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      subjectId: text('subject_id').notNull(),
      name: text('name').notNull(),
      reporterId: text('reporter_id').notNull(),
      unit: text('unit'),
      dimensions: jsonb('dimensions').$type<MetricDimensions>().default({}).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
    },
    t => [
      // Leads with the subject and name, so it also serves listing a subject's series.
      unique('metric_series_identity')
        .on(t.organisationId, t.subjectId, t.name, t.reporterId, t.unit, t.dimensions)
        .nullsNotDistinct(),
      unique('metric_series_organisation_id').on(t.organisationId, t.id)
    ]
  ),
  t => ({ name: 'metricSeries', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);

/**
 * A series' summary of an interval that ends at `observed_at`: the reporter sampled the metric `count` times and
 * reports their least, greatest, mean and last values. A single sample is a summary whose values are all equal.
 *
 * A TimescaleDB hypertable in one-day chunks (the `metric_point_hypertable` migration), so old points are dropped a
 * chunk at a time. Its key makes a resubmitted point a duplicate, which ingestion skips.
 */
export const metricPoints = withAccess(
  pgTable(
    'metric_point',
    {
      seriesId: uuid('series_id').notNull(),
      organisationId: uuid('organisation_id').notNull(),
      observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
      min: doublePrecision('min').notNull(),
      max: doublePrecision('max').notNull(),
      avg: doublePrecision('avg').notNull(),
      last: doublePrecision('last').notNull(),
      count: integer('count').notNull()
    },
    t => [
      primaryKey({ columns: [t.seriesId, t.observedAt] }),
      foreignKey({
        name: 'metric_point_series_fk',
        columns: [t.organisationId, t.seriesId],
        foreignColumns: [metricSeries.organisationId, metricSeries.id]
      }).onDelete('cascade')
    ]
  ),
  t => ({ name: 'metricPoints', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);
