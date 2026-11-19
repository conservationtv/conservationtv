import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, check, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  ACTIVITIES,
  type Activity,
  HEALTHS,
  type Health,
  type OpinionState,
  type ReportedFinding,
  type SubjectHealthState
} from '../../health/health.ts';
import type { Settings } from '../../topology/settings.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

const healthCheck = (column: AnyPgColumn) =>
  sql`${column} in (${sql.raw(HEALTHS.map(health => `'${health}'`).join(', '))})`;

const activityCheck = (column: AnyPgColumn) =>
  sql`${column} in (${sql.raw(ACTIVITIES.map(activity => `'${activity}'`).join(', '))})`;

/**
 * An accepted event report: the single logical event stream that the state consumer reads, in receipt order by its
 * `uuidv7()` ID. Its organisation reference does not cascade, so deleting an organisation never deletes its history in
 * one transaction (deleteOrganisation).
 */
export const observations = withAccess(
  pgTable(
    'observation',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id),
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      reporterId: text('reporter_id').notNull(),
      subjectId: text('subject_id').notNull(),
      observedAt: timestamp('observed_at').notNull(),
      receivedAt: timestamp('received_at').defaultNow().notNull(),
      type: text('type').notNull(),
      data: jsonb('data').$type<Settings>().default({}).notNull()
    },
    t => [index('observation_subject_observed_idx').on(t.organisationId, t.subjectId, t.observedAt)]
  ),
  t => ({ name: 'observations', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);

/**
 * One reporter's current opinion about one subject, formed by the state consumer (src/health/consumer.ts) from the
 * reporter's metrics, and why (`state`). Each expires on its own: another reporter's evidence never renews it. Expiry
 * leaves `health` as last observed.
 */
export const reporterOpinions = withAccess(
  pgTable(
    'reporter_opinion',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      subjectId: text('subject_id').notNull(),
      reporterId: text('reporter_id').notNull(),
      health: text('health').$type<Health>().notNull(),
      // Whether the subject was meant to be working, so judged: only an `active` one's health is a judgement.
      activity: text('activity').$type<Activity>().default('active').notNull(),
      state: jsonb('state').$type<OpinionState>().notNull(),
      observedAt: timestamp('observed_at').notNull(),
      expiresAt: timestamp('expires_at').notNull(),
      evidenceReportIds: uuid('evidence_report_ids').array().default([]).notNull()
    },
    t => [
      primaryKey({ columns: [t.subjectId, t.reporterId] }),
      check('reporter_opinion_health', healthCheck(t.health)),
      check('reporter_opinion_activity', activityCheck(t.activity))
    ]
  ),
  t => ({ name: 'reporterOpinions', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);

/**
 * The state consumer's combined opinion about a subject, from its reporters' opinions, with their findings. Freshness is evaluated against
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
      health: text('health').$type<Health>().notNull(),
      // The most active of its reporters' opinions: `idle` and `off` subjects aren't judged, and are never a problem.
      activity: text('activity').$type<Activity>().default('active').notNull(),
      state: jsonb('state').$type<SubjectHealthState>().notNull(),
      observedAt: timestamp('observed_at').notNull(),
      expiresAt: timestamp('expires_at').notNull(),
      computedAt: timestamp('computed_at').notNull(),
      contributingReporterIds: text('contributing_reporter_ids').array().default([]).notNull(),
      evidenceReportIds: uuid('evidence_report_ids').array().default([]).notNull()
    },
    t => [
      primaryKey({ columns: [t.organisationId, t.subjectId] }),
      check('subject_state_health', healthCheck(t.health)),
      check('subject_state_activity', activityCheck(t.activity))
    ]
  ),
  t => ({ name: 'subjectStates', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);

/**
 * Each change of a subject's combined state, appended by the state consumer as it derives one that differs in health or
 * activity from the one before: what the subject became, what it was, and the findings it became it for. The history
 * `subject_state` overwrites, for a timeline of what happened. A subject going stale is not a change the consumer
 * sees, since freshness is evaluated when read: the transition after a silence says how long it was by its `at`.
 */
export const subjectTransitions = withAccess(
  pgTable(
    'subject_transition',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      subjectId: text('subject_id').notNull(),
      /** When the reports it was derived from were observed. */
      at: timestamp('at').notNull(),
      health: text('health').$type<Health>().notNull(),
      activity: text('activity').$type<Activity>().notNull(),
      /** Null for a subject's first state. */
      previousHealth: text('previous_health').$type<Health>(),
      previousActivity: text('previous_activity').$type<Activity>(),
      findings: jsonb('findings').$type<ReportedFinding[]>().notNull()
    },
    t => [
      index('subject_transition_at_idx').on(t.organisationId, t.at),
      index('subject_transition_subject_idx').on(t.organisationId, t.subjectId, t.at),
      check('subject_transition_health', healthCheck(t.health)),
      check('subject_transition_activity', activityCheck(t.activity))
    ]
  ),
  t => ({ name: 'subjectTransitions', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);
