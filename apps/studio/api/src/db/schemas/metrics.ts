import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { doublePrecision, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { MetricDimensions } from '../../topology/settings.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

/**
 * An accepted metric report: one value of a named gauge or counter about a subject, with its unit and dimensions as
 * reported. Samples are not grouped into series, so nothing fixes a metric's type or unit: two reporters measuring the
 * same thing stay apart by `reporter_id`, and are never summed.
 */
export const metricSamples = withAccess(
  pgTable(
    'metric_sample',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      reporterId: uuid('reporter_id').notNull(),
      subjectId: text('subject_id').notNull(),
      observedAt: timestamp('observed_at').notNull(),
      receivedAt: timestamp('received_at').defaultNow().notNull(),
      name: text('name').notNull(),
      type: text('type').notNull(),
      unit: text('unit'),
      dimensions: jsonb('dimensions').$type<MetricDimensions>().default({}).notNull(),
      value: doublePrecision('value').notNull()
    },
    t => [index('metric_sample_subject_observed_idx').on(t.organisationId, t.subjectId, t.observedAt)]
  ),
  t => ({ name: 'metricSamples', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);
