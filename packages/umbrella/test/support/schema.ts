import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { resourceScope, role, withAccess } from '../../src/index.js';

// Shared roles: an organisation-scoped administrator, a global auditor, and a role no table includes.
export const orgAdmin = role('orgAdmin', { assignableScopes: ['organisation'] });
export const auditor = role('auditor');
export const unused = role('unused');

/** An ordinary table without an access definition. */
export const countries = pgTable('countries', { code: text().primaryKey() });

/** A protected table that only defines a scope and declares no actions. */
export const regions = withAccess(pgTable('regions', { id: text().primaryKey() }), table => ({
  name: 'regions',
  scope: resourceScope({ name: 'region', key: table.id })
}));

export const organisations = withAccess(
  pgTable('organisations', { id: text().primaryKey(), name: text().notNull() }),
  table => ({
    name: 'organisations',
    scope: resourceScope({ name: 'organisation', key: table.id }),
    actions: { read: ['select'], write: ['update'] },
    roles: { admin: { permissions: ['read', 'write'], assignableScopes: ['organisation'], includedIn: [orgAdmin] } }
  })
);

export const projects = withAccess(
  pgTable('projects', {
    id: text().primaryKey(),
    organisationId: text('organisation_id').notNull(),
    name: text().notNull()
  }),
  table => ({
    name: 'projects',
    scope: resourceScope({
      name: 'project',
      key: table.id,
      parent: organisations.$access.scope.via(table.organisationId)
    }),
    actions: { read: ['select'], write: ['update'], create: ['insert'], remove: ['delete'] },
    roles: {
      member: { permissions: ['read'], assignableScopes: ['project'] },
      lead: { permissions: ['read', 'write', 'create'], assignableScopes: ['project'] },
      admin: {
        permissions: ['read', 'write', 'create', 'remove'],
        assignableScopes: ['organisation'],
        includedIn: [orgAdmin]
      }
    }
  })
);

export const tasks = withAccess(
  pgTable('tasks', { id: text().primaryKey(), projectId: text('project_id').notNull(), title: text().notNull() }),
  table => ({
    name: 'tasks',
    scope: projects.$access.scope.via(table.projectId),
    actions: { read: ['select'], write: ['insert', 'update'], remove: ['delete'] },
    roles: {
      viewer: {
        permissions: ['read'],
        assignableScopes: ['global', 'organisation', 'project'],
        includedIn: [auditor]
      },
      editor: { permissions: ['read', 'write'], assignableScopes: ['project'] },
      owner: {
        permissions: ['read', 'write', 'remove'],
        assignableScopes: ['organisation', 'project'],
        includedIn: [orgAdmin]
      }
    }
  })
);

/** Two bindings to the same scope level: either project grants access. */
export const transfers = withAccess(
  pgTable('transfers', {
    id: text().primaryKey(),
    fromProjectId: text('from_project_id').notNull(),
    toProjectId: text('to_project_id').notNull()
  }),
  table => ({
    name: 'transfers',
    scopes: {
      source: projects.$access.scope.via(table.fromProjectId),
      destination: projects.$access.scope.via(table.toProjectId)
    },
    actions: { read: ['select'] },
    roles: { viewer: { permissions: ['read'], assignableScopes: ['project'] } }
  })
);

/** Organisation-bound and read-only: no role can write or delete. */
export const notes = withAccess(
  pgTable('notes', {
    id: text().primaryKey(),
    organisationId: text('organisation_id').notNull(),
    body: text().notNull()
  }),
  table => ({
    name: 'notes',
    scope: organisations.$access.scope.via(table.organisationId),
    actions: { read: ['select'] },
    roles: { reader: { permissions: ['read'], assignableScopes: ['organisation'] } }
  })
);

/** Integer scope keys, nested under organisations. */
export const devices = withAccess(
  pgTable('devices', { id: integer().primaryKey(), organisationId: text('organisation_id').notNull() }),
  table => ({
    name: 'devices',
    scope: resourceScope({
      name: 'device',
      key: table.id,
      parent: organisations.$access.scope.via(table.organisationId)
    }),
    actions: { read: ['select'] },
    roles: { admin: { permissions: ['read'], assignableScopes: ['organisation'], includedIn: [orgAdmin] } }
  })
);

export const readings = withAccess(
  pgTable('readings', {
    id: text().primaryKey(),
    deviceId: integer('device_id').notNull(),
    value: integer().notNull()
  }),
  table => ({
    name: 'readings',
    scope: devices.$access.scope.via(table.deviceId),
    actions: { read: ['select'], write: ['insert'] },
    roles: { sensor: { permissions: ['read', 'write'], assignableScopes: ['device'] } }
  })
);

/** UUID scope keys, whose canonical text form is lowercase. */
export const vaults = withAccess(pgTable('vaults', { id: uuid().primaryKey(), label: text().notNull() }), table => ({
  name: 'vaults',
  scope: resourceScope({ name: 'vault', key: table.id }),
  actions: { read: ['select'] },
  roles: { keeper: { permissions: ['read'], assignableScopes: ['vault'] } }
}));

export const tables = {
  countries,
  regions,
  organisations,
  projects,
  tasks,
  transfers,
  notes,
  devices,
  readings,
  vaults
};
export const sharedRoles = { orgAdmin, auditor, unused };

export const organisation = (id: string) => organisations.$access.scope.at(id);
export const project = (id: string) => projects.$access.scope.at(id);
export const device = (id: number) => devices.$access.scope.at(id);
export const vault = (id: string) => vaults.$access.scope.at(id);

export const VAULT = '0b9a3c52-6f1e-4d5a-9c1b-2f4e6a8b0c1d';

/** Seed data: Acme owns Apollo and Zeus; Globex owns Gemini. Each project has one task. */
export const ddl = `
  create table countries (code text primary key);
  create table regions (id text primary key);
  create table organisations (id text primary key, name text not null);
  create table projects (
    id text primary key, organisation_id text not null references organisations(id), name text not null
  );
  create table tasks (id text primary key, project_id text not null references projects(id), title text not null);
  create table transfers (
    id text primary key,
    from_project_id text not null references projects(id),
    to_project_id text not null references projects(id)
  );
  create table notes (id text primary key, organisation_id text not null references organisations(id), body text not null);
  create table devices (id integer primary key, organisation_id text not null references organisations(id));
  create table readings (id text primary key, device_id integer not null references devices(id), value integer not null);
  create table vaults (id uuid primary key, label text not null);

  insert into countries values ('GB');
  insert into regions values ('emea');
  insert into organisations values ('acme', 'Acme'), ('globex', 'Globex');
  insert into projects values ('apollo', 'acme', 'Apollo'), ('zeus', 'acme', 'Zeus'), ('gemini', 'globex', 'Gemini');
  insert into tasks values ('apollo-1', 'apollo', 'Launch'), ('zeus-1', 'zeus', 'Strike'), ('gemini-1', 'gemini', 'Orbit');
  insert into transfers values ('apollo-to-gemini', 'apollo', 'gemini'), ('zeus-to-zeus', 'zeus', 'zeus');
  insert into notes values ('acme-note', 'acme', 'Acme only'), ('globex-note', 'globex', 'Globex only');
  insert into devices values (1, 'acme'), (2, 'globex');
  insert into readings values ('r1', 1, 10), ('r2', 2, 20);
  insert into vaults values ('${VAULT}', 'Vault');
`;
