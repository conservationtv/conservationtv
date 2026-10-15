import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid
} from 'drizzle-orm/pg-core';
import type { MetricDimensions } from '../../topology/settings.ts';
import { agentSigningKeys, agents } from './agents.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

/**
 * A metric series: one reporter's measurements of one named quantity about one subject, with its dimensions. Two
 * reporters measuring the same thing are two series, never summed. Type and unit are fixed by the first report.
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
      reporterId: uuid('reporter_id').notNull(),
      name: text('name').notNull(),
      type: text('type').notNull(),
      unit: text('unit'),
      dimensions: jsonb('dimensions').$type<MetricDimensions>().default({}).notNull()
    },
    t => [
      check('metric_series_type', sql`${t.type} in ('gauge', 'counter')`),
      unique('metric_series_identity').on(t.subjectId, t.name, t.dimensions, t.reporterId),
      unique('metric_series_organisation_reporter_id').on(t.organisationId, t.reporterId, t.id),
      foreignKey({
        name: 'metric_series_reporter_fk',
        columns: [t.organisationId, t.reporterId],
        foreignColumns: [agents.organisationId, agents.id]
      }).onDelete('cascade'),
      index('metric_series_reporter_idx').on(t.reporterId)
    ]
  ),
  t => ({ name: 'metricSeries', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);

/** One accepted metric report: a timestamped value in its series. */
export const metricSamples = withAccess(
  pgTable(
    'metric_sample',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      reporterId: uuid('reporter_id').notNull(),
      reportId: uuid('report_id').notNull(),
      seriesId: uuid('series_id').notNull(),
      keyId: uuid('key_id')
        .notNull()
        .references(() => agentSigningKeys.id),
      observedAt: timestamp('observed_at').notNull(),
      receivedAt: timestamp('received_at').defaultNow().notNull(),
      value: doublePrecision('value').notNull()
    },
    t => [
      primaryKey({ columns: [t.reporterId, t.reportId] }),
      foreignKey({
        name: 'metric_sample_series_fk',
        columns: [t.organisationId, t.reporterId, t.seriesId],
        foreignColumns: [metricSeries.organisationId, metricSeries.reporterId, metricSeries.id]
      }).onDelete('cascade'),
      index('metric_sample_series_observed_idx').on(t.seriesId, t.observedAt)
    ]
  ),
  t => ({ name: 'metricSamples', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);
