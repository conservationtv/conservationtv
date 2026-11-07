import { withAccess } from '@conservationtv/umbrella';
import { foreignKey, index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * Where a show (src/shows) goes out: the agent that drives OBS for it, following the show and playing its streams
 * (apps/agent/core/src/runtimes/obs). A show has at most one output. A show is its organisation's broadcast for now, so
 * its ID is the organisation's; shows of their own will keep the same key.
 */
export const showOutputs = withAccess(
  pgTable(
    'show_output',
    {
      showId: uuid('show_id').primaryKey(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      deviceId: uuid('device_id').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      // The output is one of the organisation's agents, and goes with it.
      foreignKey({
        name: 'show_output_agent_fk',
        columns: [t.organisationId, t.deviceId],
        foreignColumns: [agents.organisationId, agents.id]
      }).onDelete('cascade'),
      index('show_output_device_idx').on(t.deviceId)
    ]
  ),
  t => ({
    name: 'showOutputs',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.showId, t.organisationId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);
