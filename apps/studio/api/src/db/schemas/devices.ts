import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { DEVICE_KINDS, type DeviceKind } from '../../topology/device-kinds.ts';
import { BytesSchema, encrypted } from '../encrypted.ts';
import { networks } from './networks.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * What every device has, on a managed network or (`network_id` null) the internet: its name, and an Ed25519 identity
 * from creation (src/topology/identity.ts). The public key and public ID never change, and the private key is
 * encrypted at rest and never readable in a request session. Everything else belongs to its kind (`agent`,
 * `camera` or `browser`), whose row shares the device's ID; the kind never changes, so a device is only ever one of them.
 */
export const devices = withAccess(
  pgTable(
    'device',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      kind: text('kind').$type<DeviceKind>().notNull(),
      name: text('name').notNull(),
      networkId: uuid('network_id'),
      publicKey: text('public_key').notNull(),
      publicId: text('public_id').notNull(),
      privateKey: encrypted('device.private_key', BytesSchema)('private_key').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('device_organisation_id').on(t.organisationId, t.id),
      unique('device_organisation_id_kind').on(t.organisationId, t.id, t.kind),
      unique('device_organisation_id_kind_network').on(t.organisationId, t.id, t.kind, t.networkId),
      unique('device_public_id').on(t.publicId),
      check('device_kind', sql.raw(`kind in (${DEVICE_KINDS.map(kind => `'${kind}'`).join(', ')})`)),
      check('device_public_id_hex', sql`${t.publicId} ~ '^[0-9a-f]{64}$'`),
      // Browsers reach everything through a relay, from the internet.
      check('device_browser_internet', sql`${t.kind} <> 'browser' or ${t.networkId} is null`),
      foreignKey({
        name: 'device_network_fk',
        columns: [t.organisationId, t.networkId],
        foreignColumns: [networks.organisationId, networks.id]
      }),
      index('device_network_idx').on(t.networkId)
    ]
  ),
  t => ({
    name: 'devices',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.kind, t.publicKey, t.publicId, t.privateKey, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);
