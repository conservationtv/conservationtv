import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { CredentialsSchema, ProviderStateSchema, type Settings } from '../../topology/settings.ts';
import { encrypted, json } from '../encrypted.ts';
import { networks } from './networks.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * Somewhere streams are delivered to, reachable on a managed network or (`network_id` null) the internet, such as
 * MediaMTX on a network's active agent. Its `kind` is the implementation, one of the gateway providers
 * (src/gateways/index.ts), which decides the protocols it is published to and read by; its `settings` are whatever
 * that provider reads, such as where its servers listen. Its `credentials` are the secrets the provider authenticates
 * with, such as an API token, written by administrators and never readable by request sessions; its `provider_state`
 * is what the provider keeps for itself, such as what it made at the service behind it, written only by trusted code
 * and cleared whenever what it was made with changes.
 */
export const gateways = withAccess(
  pgTable(
    'gateway',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      kind: text('kind').notNull(),
      networkId: uuid('network_id'),
      settings: jsonb('settings').$type<Settings>().default({}).notNull(),
      credentials: encrypted('gateway.credentials', json(CredentialsSchema))('credentials'),
      providerState: encrypted('gateway.provider_state', json(ProviderStateSchema))('provider_state'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('gateway_organisation_id').on(t.organisationId, t.id),
      foreignKey({
        name: 'gateway_network_fk',
        columns: [t.organisationId, t.networkId],
        foreignColumns: [networks.organisationId, networks.id]
      }),
      index('gateway_network_idx').on(t.networkId)
    ]
  ),
  t => ({
    name: 'gateways',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.createdAt],
    hidden: [t.credentials, t.providerState],
    actions: topologyActions,
    roles: topologyRoles
  })
);
