import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { organisationMember, self } from '../roles.ts';
import { session } from './auth.ts';
import { devices } from './devices.ts';
import { organisationMemberships, organisations } from './organisations.ts';
import { users } from './users.ts';

/**
 * A device that is one signed-in browser in one organisation, for iroh connections through a relay: there is at most
 * one per auth session and organisation, made on demand (src/topology/browsers.ts). It belongs to the account as well
 * as the organisation, and lasts only as long as both its session and the account's membership: deleting either
 * deletes this row, and a trigger in the `browser_devices` migration deletes its device with it.
 */
export const browsers = withAccess(
  pgTable(
    'browser',
    {
      id: uuid('id').primaryKey(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      kind: text('kind')
        .generatedAlwaysAs(sql`'browser'`)
        .notNull(),
      userId: text('user_id').notNull(),
      sessionId: text('session_id')
        .notNull()
        .references(() => session.id, { onDelete: 'cascade' })
    },
    t => [
      unique('browser_session_organisation').on(t.sessionId, t.organisationId),
      // The browser is its device, which is a browser and nothing else.
      foreignKey({
        name: 'browser_device_fk',
        columns: [t.organisationId, t.id, t.kind],
        foreignColumns: [devices.organisationId, devices.id, devices.kind]
      }),
      // Only a member's browser, and only while they are one.
      foreignKey({
        name: 'browser_membership_fk',
        columns: [t.organisationId, t.userId],
        foreignColumns: [organisationMemberships.organisationId, organisationMemberships.userId]
      }).onDelete('cascade'),
      index('browser_user_idx').on(t.userId)
    ]
  ),
  t => ({
    name: 'browsers',
    scopes: {
      organisation: organisations.$access.scope.via(t.organisationId),
      account: users.$access.scope.via(t.userId)
    },
    actions: { read: ['select'] },
    roles: {
      own: {
        label: 'Own browsers',
        permissions: ['read'],
        assignableScopes: ['user'],
        includedIn: [self]
      },
      member: {
        label: 'Member',
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [organisationMember]
      }
    }
  })
);
