import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid
} from 'drizzle-orm/pg-core';
import type { Settings } from '../../topology/settings.ts';
import { devices } from './devices.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

const healthCheck = (column: AnyPgColumn) => sql`${column} in ('healthy', 'unhealthy', 'unknown')`;

/**
 * An accepted event report: the single logical event stream that the state consumer reads, in receipt order by its
 * `uuidv7()` ID.
 */
export const observations = withAccess(
  pgTable(
    'observation',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      reporterId: uuid('reporter_id').notNull(),
      subjectId: text('subject_id').notNull(),
      observedAt: timestamp('observed_at').notNull(),
      receivedAt: timestamp('received_at').defaultNow().notNull(),
      type: text('type').notNull(),
      data: jsonb('data').$type<Settings>().default({}).notNull()
    },
    t => [
      foreignKey({
        name: 'observation_reporter_fk',
        columns: [t.organisationId, t.reporterId],
        foreignColumns: [devices.organisationId, devices.id]
      }).onDelete('cascade'),
      index('observation_subject_observed_idx').on(t.organisationId, t.subjectId, t.observedAt)
    ]
  ),
  t => ({ name: 'observations', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);

/**
 * One reporter's current opinion about one subject, maintained by the state consumer. Each expires on its own:
 * another reporter's evidence never renews it. Expiry leaves `health` as last observed.
 */
export const reporterOpinions = withAccess(
  pgTable(
    'reporter_opinion',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      subjectId: text('subject_id').notNull(),
      reporterId: uuid('reporter_id').notNull(),
      health: text('health').notNull(),
      state: jsonb('state').$type<Settings>().default({}).notNull(),
      observedAt: timestamp('observed_at').notNull(),
      expiresAt: timestamp('expires_at').notNull(),
      evidenceReportIds: uuid('evidence_report_ids').array().default([]).notNull()
    },
    t => [
      primaryKey({ columns: [t.subjectId, t.reporterId] }),
      check('reporter_opinion_health', healthCheck(t.health)),
      foreignKey({
        name: 'reporter_opinion_reporter_fk',
        columns: [t.organisationId, t.reporterId],
        foreignColumns: [devices.organisationId, devices.id]
      }).onDelete('cascade')
    ]
  ),
  t => ({ name: 'reporterOpinions', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);

/**
 * The state consumer's combined opinion about a subject, from its reporters' opinions. Freshness is evaluated against
 * `expires_at` when read, so a subject goes stale (unreachable) without a new report, and keeps its last health.
 */
export const subjectStates = withAccess(
  pgTable(
    'subject_state',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      subjectId: text('subject_id').notNull(),
      health: text('health').notNull(),
      state: jsonb('state').$type<Settings>().default({}).notNull(),
      observedAt: timestamp('observed_at').notNull(),
      expiresAt: timestamp('expires_at').notNull(),
      computedAt: timestamp('computed_at').notNull(),
      contributingReporterIds: uuid('contributing_reporter_ids').array().default([]).notNull(),
      evidenceReportIds: uuid('evidence_report_ids').array().default([]).notNull()
    },
    t => [
      primaryKey({ columns: [t.organisationId, t.subjectId] }),
      check('subject_state_health', healthCheck(t.health))
    ]
  ),
  t => ({ name: 'subjectStates', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);
