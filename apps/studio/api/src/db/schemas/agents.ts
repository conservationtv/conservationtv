import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { boolean, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { devices } from './devices.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A device that is an agent, serving the network it is on: the agent shares the device's ID, and with it the device's
 * name and identity. A network may have several agents for high availability; at most one is
 * active, which the partial unique index guarantees.
 */
export const agents = withAccess(
  pgTable(
    'agent',
    {
      id: uuid('id').primaryKey(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      kind: text('kind')
        .generatedAlwaysAs(sql`'agent'`)
        .notNull(),
      networkId: uuid('network_id').notNull(),
      priority: integer('priority').default(0).notNull(),
      active: boolean('active').default(false).notNull()
    },
    t => [
      unique('agent_organisation_id').on(t.organisationId, t.id),
      // The agent is its device, which is an agent and nothing else, on the device's network: the network cannot change
      // while it is an agent.
      foreignKey({
        name: 'agent_device_fk',
        columns: [t.organisationId, t.id, t.kind, t.networkId],
        foreignColumns: [devices.organisationId, devices.id, devices.kind, devices.networkId]
      }),
      uniqueIndex('agent_network_active')
        .on(t.networkId)
        .where(sql`${t.active}`),
      index('agent_network_idx').on(t.networkId)
    ]
  ),
  t => ({
    name: 'agents',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.networkId],
    actions: topologyActions,
    roles: topologyRoles
  })
);
