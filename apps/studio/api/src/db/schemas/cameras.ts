import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { foreignKey, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Settings } from '../../topology/settings.ts';
import { devices } from './devices.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A device that is a camera: it shares the device's ID, and with it the device's name, network and identity. Its
 * `settings` describe it, including the endpoints it offers by itself, from which those are derived.
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
      settings: jsonb('settings').$type<Settings>().default({}).notNull()
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
    actions: topologyActions,
    roles: topologyRoles
  })
);
