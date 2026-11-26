import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { type ExposureParams, type Settings } from '../../topology/settings.ts';
import { devices } from './devices.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

// The named qualities exposures and recorders were set to before a delivery carried one picture (docs/shows.md, Sizes),
// which only the deprecated `exposure.renditions` and `recorder.rendition` still hold.
type RemovedRendition = 'default' | 'data_saver' | 'balanced' | 'quality';

/**
 * The lasting identity of a logical video feed. Its source is a device of the same organisation, usually a camera (the
 * system resolves which of the camera's own endpoints to use), or none yet. Replacing the camera does not make a new
 * stream. Its `code` is a short name for it, at most four capitals and digits, unique in its organisation: what chat
 * and the studio's controls may call it by (docs/shows.md).
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
      code: text('code'),
      sourceDeviceId: uuid('source_device_id'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('stream_organisation_id').on(t.organisationId, t.id),
      unique('stream_organisation_code').on(t.organisationId, t.code),
      check('stream_code', sql`${t.code} ~ '^[A-Z0-9]{1,4}$'`),
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
 * network, or the internet) and by which protocols. It carries the one picture its source gives, and, where its
 * protocol can (a MoQ broadcast's catalog), smaller ones the system decides from what the source can do: never
 * configured here (docs/shows.md, Delivery). Its publisher is the device that sends it there: the pinned
 * `publisher_device_id`, or (null) whichever the configuration builders choose, the source camera itself when it can
 * or an agent on its network. What it publishes is the stream's source, or `upstream_exposure_id`'s delivery of the
 * same stream, so exposures chain: camera, MediaMTX on its network, then a relay on the internet. An exposure another
 * uses as its upstream cannot be deleted from under it.
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
      /**
       * @deprecated Read by nothing; never write it. Kept, as at its removal, for the Worker still serving while a
       * release's migrations run (which reads and writes it), and as the record of which exposures offered smaller
       * renditions, which a size cap may carry over. New rows take the default. Dropped in a later release
       * (docs/shows.md, Sizes).
       */
      renditions: text('renditions')
        .$type<RemovedRendition>()
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
 * A recording responsibility, always backed by an exposure of its own stream, recording the largest picture it carries:
 * that exposure supplies the gateway. An exposure a recorder uses cannot be deleted from under it.
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
      /**
       * @deprecated Read by nothing; never write it. Kept, as `exposure.renditions` is and for the same reasons, until a
       * later release drops it (docs/shows.md, Sizes).
       */
      rendition: text('rendition').$type<RemovedRendition>().default('default').notNull(),
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
