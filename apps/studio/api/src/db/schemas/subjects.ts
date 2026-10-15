import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A stable identity for something observed: a topology entity (its `kind` names which) or an external target such as
 * a website. Observations, metrics, logs and derived state join on it; the label is only for display.
 */
export const subjects = withAccess(
  pgTable(
    'subject',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      kind: text('kind').notNull(),
      label: text('label'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [unique('subject_organisation_id').on(t.organisationId, t.id)]
  ),
  t => ({
    name: 'subjects',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.kind, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);
