import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { NativeExposure, Settings } from '../../topology/settings.ts';
import { BytesSchema, encrypted } from '../encrypted.ts';
import { networks } from './networks.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A camera, server or other device, on a managed network or (`network_id` null) the internet. `native_exposures` are
 * the endpoints it offers by itself, as opposed to the exposures streams manage. Each has an Ed25519 identity from
 * creation (src/topology/identity.ts): the public key and public ID never change, and the private key is encrypted at
 * rest and never readable in a request session.
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
      type: text('type').notNull(),
      name: text('name').notNull(),
      networkId: uuid('network_id'),
      nativeExposures: jsonb('native_exposures').$type<NativeExposure[]>().default([]).notNull(),
      settings: jsonb('settings').$type<Settings>().default({}).notNull(),
      publicKey: text('public_key').notNull(),
      publicId: text('public_id').notNull(),
      privateKey: encrypted('device.private_key', BytesSchema)('private_key').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('device_organisation_id').on(t.organisationId, t.id),
      unique('device_organisation_id_network').on(t.organisationId, t.id, t.networkId),
      unique('device_public_id').on(t.publicId),
      check('device_public_id_hex', sql`${t.publicId} ~ '^[0-9a-f]{64}$'`),
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
    immutable: [t.publicKey, t.publicId, t.privateKey, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);
