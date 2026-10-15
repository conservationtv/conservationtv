import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import type { BuildDiagnostic, Settings } from '../../topology/settings.ts';
import { devices } from './devices.ts';
import { networks } from './networks.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * An agent serving one network from a host device of the same organisation. A network may have several for high
 * availability; at most one is active, which the partial unique index guarantees.
 */
export const agents = withAccess(
  pgTable(
    'agent',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      networkId: uuid('network_id').notNull(),
      deviceId: uuid('device_id').notNull(),
      priority: integer('priority').default(0).notNull(),
      active: boolean('active').default(false).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('agent_organisation_id').on(t.organisationId, t.id),
      foreignKey({
        name: 'agent_network_fk',
        columns: [t.organisationId, t.networkId],
        foreignColumns: [networks.organisationId, networks.id]
      }),
      foreignKey({
        name: 'agent_device_fk',
        columns: [t.organisationId, t.deviceId],
        foreignColumns: [devices.organisationId, devices.id]
      }),
      uniqueIndex('agent_network_active')
        .on(t.networkId)
        .where(sql`${t.active}`),
      index('agent_network_idx').on(t.networkId),
      index('agent_device_idx').on(t.deviceId)
    ]
  ),
  t => ({
    name: 'agents',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.networkId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A rendered candidate configuration for an agent, with every diagnostic its builders reported. Candidates never
 * change; `served` marks the one the agent is given, at most one per agent, and never one with an error.
 */
export const configurationRevisions = withAccess(
  pgTable(
    'configuration_revision',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      agentId: uuid('agent_id').notNull(),
      config: jsonb('config').$type<Settings>().notNull(),
      diagnostics: jsonb('diagnostics').$type<BuildDiagnostic[]>().default([]).notNull(),
      hasErrors: boolean('has_errors')
        .generatedAlwaysAs(sql`jsonb_path_exists(diagnostics, '$[*] ? (@.severity == "error")')`)
        .notNull(),
      served: boolean('served').default(false).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      check('configuration_revision_served_usable', sql`not (${t.served} and ${t.hasErrors})`),
      foreignKey({
        name: 'configuration_revision_agent_fk',
        columns: [t.organisationId, t.agentId],
        foreignColumns: [agents.organisationId, agents.id]
      }).onDelete('cascade'),
      uniqueIndex('configuration_revision_agent_served')
        .on(t.agentId)
        .where(sql`${t.served}`),
      index('configuration_revision_agent_idx').on(t.agentId)
    ]
  ),
  t => ({
    name: 'configurationRevisions',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.agentId, t.config, t.diagnostics, t.createdAt],
    actions: { read: ['select'], create: ['insert'], serve: ['update'] },
    roles: {
      member: topologyRoles.member,
      admin: { ...topologyRoles.admin, permissions: ['read', 'create', 'serve'] }
    }
  })
);
