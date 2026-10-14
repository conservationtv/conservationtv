import { doublePrecision, integer, pgTable, primaryKey, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { resourceScope, roleAssignments, withAccess } from '../src/index.js';
import { admin, reader, organisationAdmin } from './roles.js';

export { roleAssignments };

export const users = pgTable('users', { id: text().primaryKey(), name: text().notNull() });

export const organisations = withAccess(
  pgTable('organisations', { id: text().primaryKey(), name: text().notNull() }),
  table => ({
    name: 'organisations',
    scope: resourceScope({ name: 'organisation', key: table.id }),
    actions: { read: ['select'], write: ['update'] },
    roles: {
      admin: {
        permissions: ['read', 'write'],
        assignableScopes: ['organisation'],
        includedIn: [admin, organisationAdmin]
      }
    }
  })
);

export const organisationUsers = withAccess(
  pgTable(
    'organisation_users',
    {
      organisationId: text('organisation_id')
        .notNull()
        .references(() => organisations.id),
      userId: text('user_id')
        .notNull()
        .references(() => users.id)
    },
    table => [primaryKey({ columns: [table.organisationId, table.userId] })]
  ),
  table => ({
    name: 'organisationUsers',
    scope: organisations.$access.scope.via(table.organisationId),
    actions: { listUsers: ['select'], addUsers: ['insert'], removeUsers: ['delete'] },
    roles: {
      admin: {
        permissions: ['listUsers', 'addUsers', 'removeUsers'],
        assignableScopes: ['organisation'],
        includedIn: [admin, organisationAdmin]
      }
    }
  })
);

export const devices = withAccess(
  pgTable('devices', {
    id: integer().primaryKey(),
    name: text().notNull(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organisations.id)
  }),
  table => ({
    name: 'devices',
    scope: resourceScope({
      name: 'device',
      key: table.id,
      parent: organisations.$access.scope.via(table.organisationId)
    }),
    actions: { read: ['select'], write: ['insert', 'update'], remove: ['delete'] },
    roles: {
      admin: {
        permissions: ['read', 'write', 'remove'],
        assignableScopes: ['organisation'],
        includedIn: [admin, organisationAdmin]
      }
    }
  })
);

export const projects = withAccess(
  pgTable('projects', {
    id: text().primaryKey(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organisations.id),
    name: text().notNull()
  }),
  table => ({
    name: 'projects',
    scope: resourceScope({
      name: 'project',
      key: table.id,
      parent: organisations.$access.scope.via(table.organisationId)
    }),
    actions: { read: ['select'], write: ['insert', 'update'], remove: ['delete'] },
    roles: {
      reader: {
        label: 'Project reader',
        description: 'Read this project.',
        permissions: ['read'],
        assignableScopes: ['project'],
        includedIn: [reader]
      },
      admin: {
        permissions: ['read', 'write', 'remove'],
        assignableScopes: ['project'],
        includedIn: [admin, organisationAdmin]
      }
    }
  })
);

export const metrics = withAccess(
  pgTable('metrics', {
    id: serial().primaryKey(),
    deviceId: integer('device_id')
      .notNull()
      .references(() => devices.id),
    value: doublePrecision().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow()
  }),
  table => ({
    name: 'metrics',
    scopes: { device: devices.$access.scope.via(table.deviceId) },
    actions: { read: ['select'], write: ['insert', 'update'], remove: ['delete'] },
    roles: {
      reader: { permissions: ['read'], assignableScopes: ['global', 'device'], includedIn: [reader] },
      writer: { permissions: ['read', 'write'], assignableScopes: ['device'] },
      maintainer: {
        permissions: ['read', 'write', 'remove'],
        assignableScopes: ['device'],
        includedIn: [admin, organisationAdmin]
      }
    }
  })
);

export const locations = withAccess(
  pgTable('locations', {
    id: serial().primaryKey(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organisations.id),
    name: text().notNull()
  }),
  table => ({
    name: 'locations',
    scope: organisations.$access.scope.via(table.organisationId),
    actions: { read: ['select'], write: ['insert', 'update'], remove: ['delete'] },
    roles: {
      reader: { permissions: ['read'], includedIn: [reader] },
      admin: {
        permissions: ['read', 'write', 'remove'],
        assignableScopes: ['organisation'],
        includedIn: [admin, organisationAdmin]
      }
    }
  })
);
