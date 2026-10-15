import { withAccess } from '@conservationtv/umbrella';
import { foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Settings } from '../../topology/settings.ts';
import { agentSigningKeys, agents } from './agents.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

/** An accepted log report. */
export const logRecords = withAccess(
  pgTable(
    'log_record',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      reporterId: uuid('reporter_id').notNull(),
      id: uuid('id').notNull(),
      subjectId: text('subject_id').notNull(),
      keyId: uuid('key_id')
        .notNull()
        .references(() => agentSigningKeys.id),
      observedAt: timestamp('observed_at').notNull(),
      receivedAt: timestamp('received_at').defaultNow().notNull(),
      level: text('level').notNull(),
      message: text('message').notNull(),
      context: jsonb('context').$type<Settings>().default({}).notNull()
    },
    t => [
      primaryKey({ columns: [t.reporterId, t.id] }),
      foreignKey({
        name: 'log_record_reporter_fk',
        columns: [t.organisationId, t.reporterId],
        foreignColumns: [agents.organisationId, agents.id]
      }).onDelete('cascade'),
      index('log_record_subject_observed_idx').on(t.organisationId, t.subjectId, t.observedAt)
    ]
  ),
  t => ({ name: 'logRecords', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);
