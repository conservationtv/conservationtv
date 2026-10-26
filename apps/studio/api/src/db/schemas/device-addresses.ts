import { withAccess } from '@conservationtv/umbrella';
import { boolean, foreignKey, inet, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { devices } from './devices.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

/**
 * An address a device reports it can be reached at on its own network (src/services/device-addresses.ts): what it
 * found on its interfaces, not what anything has verified. A device replaces its set whole each time it reports, so
 * the rows are its latest report and nothing older; at most one is `preferred`, the one its default route leaves by.
 * The device's own signature authenticates the report, so trusted code writes them and request sessions only read, as
 * for reports. They go with their device.
 */
export const deviceAddresses = withAccess(
  pgTable(
    'device_address',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      deviceId: uuid('device_id').notNull(),
      address: inet('address').notNull(),
      /** The interface it was found on, as the device names it, such as `eth0` or `en0`. */
      interface: text('interface').notNull(),
      preferred: boolean('preferred').default(false).notNull(),
      reportedAt: timestamp('reported_at').defaultNow().notNull()
    },
    t => [
      primaryKey({ columns: [t.deviceId, t.address] }),
      foreignKey({
        name: 'device_address_device_fk',
        columns: [t.organisationId, t.deviceId],
        foreignColumns: [devices.organisationId, devices.id]
      }).onDelete('cascade')
    ]
  ),
  t => ({ name: 'deviceAddresses', scope: organisations.$access.scope.via(t.organisationId), ...observationAccess })
);
