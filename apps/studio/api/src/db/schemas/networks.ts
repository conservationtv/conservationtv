import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/** A managed network: one or more agents serve it, one of them active at a time. */
export const networks = withAccess(
  pgTable(
    'network',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [unique('network_organisation_id').on(t.organisationId, t.id)]
  ),
  t => ({
    name: 'networks',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);
