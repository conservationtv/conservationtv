import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { ExposureParams, Settings } from '../../topology/settings.ts';
import { devices } from './devices.ts';
import { networks } from './networks.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * The lasting identity of a logical video feed. Its source is a device of the same organisation (the system resolves
 * which of the device's native feeds to use), or none yet. Replacing the camera does not make a new stream.
 */
export const streams = withAccess(
  pgTable(
    'stream',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      sourceDeviceId: uuid('source_device_id'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('stream_organisation_id').on(t.organisationId, t.id),
      foreignKey({
        name: 'stream_source_device_fk',
        columns: [t.organisationId, t.sourceDeviceId],
        foreignColumns: [devices.organisationId, devices.id]
      }),
      index('stream_source_device_idx').on(t.sourceDeviceId)
    ]
  ),
  t => ({
    name: 'streams',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * How a stream is delivered: on a managed network or (`network_id` null) the internet, by a protocol, with the
 * renditions it should offer in `params`. Paths and processes that realise it are derived by the configuration
 * builders.
 */
export const exposures = withAccess(
  pgTable(
    'exposure',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      streamId: uuid('stream_id').notNull(),
      networkId: uuid('network_id'),
      protocol: text('protocol').notNull(),
      params: jsonb('params').$type<ExposureParams>().default({}).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('exposure_stream_id').on(t.streamId, t.id),
      foreignKey({
        name: 'exposure_stream_fk',
        columns: [t.organisationId, t.streamId],
        foreignColumns: [streams.organisationId, streams.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'exposure_network_fk',
        columns: [t.organisationId, t.networkId],
        foreignColumns: [networks.organisationId, networks.id]
      }),
      index('exposure_network_idx').on(t.networkId)
    ]
  ),
  t => ({
    name: 'exposures',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.streamId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A recording responsibility, always backed by an exposure of its own stream: that exposure supplies the network and
 * protocol. An exposure a recorder uses cannot be deleted from under it.
 */
export const recorders = withAccess(
  pgTable(
    'recorder',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      streamId: uuid('stream_id').notNull(),
      exposureId: uuid('exposure_id').notNull(),
      kind: text('kind').notNull(),
      params: jsonb('params').$type<Settings>().default({}).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      foreignKey({
        name: 'recorder_stream_fk',
        columns: [t.organisationId, t.streamId],
        foreignColumns: [streams.organisationId, streams.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'recorder_exposure_fk',
        columns: [t.streamId, t.exposureId],
        foreignColumns: [exposures.streamId, exposures.id]
      }),
      index('recorder_stream_idx').on(t.streamId),
      index('recorder_exposure_idx').on(t.exposureId)
    ]
  ),
  t => ({
    name: 'recorders',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.streamId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);
