import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { type ExposureParams, type Rendition, type Settings } from '../../topology/settings.ts';
import { devices } from './devices.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * The lasting identity of a logical video feed. Its source is a device of the same organisation, usually a camera (the
 * system resolves which of the camera's own endpoints to use), or none yet. Replacing the camera does not make a new
 * stream.
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
 * How a stream is delivered: to a gateway, built in or the organisation's own, which decides where it can be read (its
 * network, or the internet) and by which protocols, offering the `renditions` it lists. Its publisher is the device
 * that sends it there: the pinned `publisher_device_id`, or (null) whichever the configuration builders choose, the
 * source camera itself when it can or an agent on its network. What it publishes is the stream's source, or
 * `upstream_exposure_id`'s delivery of the same stream, offering at most the renditions that offers, so exposures
 * chain: camera, MediaMTX on its network, then a relay on the internet. An exposure another uses as its upstream
 * cannot be deleted from under it.
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
      // A built-in gateway's slug or one of the organisation's gateways (src/topology/exposures.ts checks which).
      gatewayId: text('gateway_id').notNull(),
      renditions: text('renditions')
        .$type<Rendition>()
        .array()
        .default(sql`'{default}'`)
        .notNull(),
      publisherDeviceId: uuid('publisher_device_id'),
      upstreamExposureId: uuid('upstream_exposure_id'),
      params: jsonb('params').$type<ExposureParams>().default({}).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('exposure_stream_id').on(t.streamId, t.id),
      check('exposure_upstream_other', sql`${t.upstreamExposureId} <> ${t.id}`),
      foreignKey({
        name: 'exposure_stream_fk',
        columns: [t.organisationId, t.streamId],
        foreignColumns: [streams.organisationId, streams.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'exposure_publisher_device_fk',
        columns: [t.organisationId, t.publisherDeviceId],
        foreignColumns: [devices.organisationId, devices.id]
      }),
      // An upstream of the same stream; the routes refuse a chain that loops back on itself.
      foreignKey({
        name: 'exposure_upstream_fk',
        columns: [t.streamId, t.upstreamExposureId],
        foreignColumns: [t.streamId, t.id]
      }),
      index('exposure_gateway_idx').on(t.gatewayId),
      index('exposure_publisher_device_idx').on(t.publisherDeviceId),
      index('exposure_upstream_idx').on(t.upstreamExposureId)
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
 * A recording responsibility, always backed by an exposure of its own stream, recording one of the renditions it
 * offers: that exposure supplies the gateway. An exposure a recorder uses cannot be deleted from under it, nor stop
 * offering the rendition it records.
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
      rendition: text('rendition').$type<Rendition>().default('default').notNull(),
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
