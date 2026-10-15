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
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import type { BuildDiagnostic, Settings } from '../../topology/settings.ts';
import { organisationAdmin, organisationMember } from '../roles.ts';
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

/**
 * A public key an agent signs its reports with. Keys are revoked rather than deleted, so accepted reports keep the
 * key they were verified with.
 */
export const agentSigningKeys = withAccess(
  pgTable(
    'agent_signing_key',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      agentId: uuid('agent_id').notNull(),
      algorithm: text('algorithm').notNull(),
      publicKey: text('public_key').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull(),
      revokedAt: timestamp('revoked_at')
    },
    t => [
      check('agent_signing_key_algorithm', sql`${t.algorithm} in ('Ed25519')`),
      foreignKey({
        name: 'agent_signing_key_agent_fk',
        columns: [t.organisationId, t.agentId],
        foreignColumns: [agents.organisationId, agents.id]
      }).onDelete('cascade'),
      index('agent_signing_key_agent_idx').on(t.agentId)
    ]
  ),
  t => ({
    name: 'agentSigningKeys',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.agentId, t.algorithm, t.publicKey, t.createdAt],
    actions: { read: ['select'], create: ['insert'], revoke: ['update'] },
    roles: {
      member: {
        label: 'Member',
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [organisationMember]
      },
      admin: {
        label: 'Administrator',
        permissions: ['read', 'create', 'revoke'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);
