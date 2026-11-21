import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { CameraCredentialsSchema, type CameraPosition, type CameraSettings } from '@conservationtv/cameras';
import { CAMERA_STATES, type CameraState } from '../../cameras/states.ts';
import { encrypted, json } from '../encrypted.ts';
import { devices } from './devices.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A device that is a camera: it shares the device's ID, and with it the device's name, network and identity. Its
 * `settings` say which driver reads it (`@conservationtv/cameras`) and where its streams are; its `credentials`, kept
 * encrypted and never readable by request sessions, how to authenticate to them. Its `state` says whether it feeds its
 * streams (src/cameras/states.ts). Its `aliases` are what else it is called in chat, beside its device's name
 * (src/services/chat-commands.ts).
 */
export const cameras = withAccess(
  pgTable(
    'camera',
    {
      id: uuid('id').primaryKey(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      kind: text('kind')
        .generatedAlwaysAs(sql`'camera'`)
        .notNull(),
      settings: jsonb('settings').$type<CameraSettings>().notNull(),
      credentials: encrypted('camera.credentials', json(CameraCredentialsSchema))('credentials'),
      state: text('state').$type<CameraState>().default('enabled').notNull(),
      aliases: text('aliases')
        .array()
        .default(sql`'{}'::text[]`)
        .notNull()
    },
    t => [
      unique('camera_organisation_id').on(t.organisationId, t.id),
      check('camera_state', sql.raw(`state in (${CAMERA_STATES.map(state => `'${state}'`).join(', ')})`)),
      // The camera is its device, which is a camera and nothing else.
      foreignKey({
        name: 'camera_device_fk',
        columns: [t.organisationId, t.id, t.kind],
        foreignColumns: [devices.organisationId, devices.id, devices.kind]
      })
    ]
  ),
  t => ({
    name: 'cameras',
    scope: organisations.$access.scope.via(t.organisationId),
    hidden: [t.credentials],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * Somewhere a camera is pointed, by name: a position in the control contract's units (`@conservationtv/cameras`),
 * saved from where the camera was. Kept here, not on the camera, so a preset is the same whatever drives the camera,
 * and going to one is an ordinary move to its position. `home` is only a name people give one.
 */
export const cameraPresets = withAccess(
  pgTable(
    'camera_preset',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      cameraId: uuid('camera_id').notNull(),
      name: text('name').notNull(),
      position: jsonb('position').$type<CameraPosition>().notNull(),
      /**
       * Which picture of the position is kept for it, if any: a token naming the object in the studio's media
       * (src/services/cameras.ts), new each time the picture is replaced, so its address never serves a stale one.
       */
      thumbnail: text('thumbnail'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      // The camera's, in its organisation, and gone with it.
      foreignKey({
        name: 'camera_preset_camera_fk',
        columns: [t.organisationId, t.cameraId],
        foreignColumns: [cameras.organisationId, cameras.id]
      }).onDelete('cascade'),
      // One of each name per camera, whatever its case.
      uniqueIndex('camera_preset_camera_name').on(t.cameraId, sql`lower(${t.name})`),
      index('camera_preset_organisation_idx').on(t.organisationId)
    ]
  ),
  t => ({
    name: 'cameraPresets',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.cameraId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);
