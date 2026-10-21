import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { foreignKey, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { CameraCredentialsSchema, type CameraSettings } from '../../cameras/drivers.ts';
import { encrypted, json } from '../encrypted.ts';
import { devices } from './devices.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A device that is a camera: it shares the device's ID, and with it the device's name, network and identity. Its
 * `settings` say which driver reads it (src/cameras/drivers.ts) and where its streams are; its `credentials`, kept
 * encrypted and never readable by request sessions, how to authenticate to them.
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
      credentials: encrypted('camera.credentials', json(CameraCredentialsSchema))('credentials')
    },
    t => [
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
