import { withAccess } from '@conservationtv/umbrella';
import { foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { devices } from './devices.ts';
import { gateways } from './gateways.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

/**
 * Where a gateway's servers are reached, one URL per protocol, as the agent running it registered them
 * (src/services/gateway-endpoints.ts): what its MediaMTX actually listens on, not what anyone typed. A registration is
 * a lease: it holds until `expires_at` unless the agent renews it, so a dead agent's URLs stop being handed out, and
 * only the network's active agent's counts. The agent replaces its set whole each time, so the rows are its latest
 * registration. Its signature authenticates it, so trusted code writes them and request sessions only read, as for
 * device addresses. They go with their gateway, and with the device that registered them.
 */
export const gatewayEndpoints = withAccess(
  pgTable(
    'gateway_endpoint',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      gatewayId: uuid('gateway_id').notNull(),
      /** The agent that registered it. */
      deviceId: uuid('device_id').notNull(),
      /** One of the gateway's protocols, such as `rtsps`. */
      protocol: text('protocol').notNull(),
      /** The protocol's server, as a reader on the gateway's network reaches it. */
      url: text('url').notNull(),
      registeredAt: timestamp('registered_at').defaultNow().notNull(),
      expiresAt: timestamp('expires_at').notNull()
    },
    t => [
      primaryKey({ columns: [t.gatewayId, t.protocol] }),
      foreignKey({
        name: 'gateway_endpoint_gateway_fk',
        columns: [t.organisationId, t.gatewayId],
        foreignColumns: [gateways.organisationId, gateways.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'gateway_endpoint_device_fk',
        columns: [t.organisationId, t.deviceId],
        foreignColumns: [devices.organisationId, devices.id]
      }).onDelete('cascade'),
      index('gateway_endpoint_device_idx').on(t.deviceId)
    ]
  ),
  t => ({ name: 'gatewayEndpoints', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);
