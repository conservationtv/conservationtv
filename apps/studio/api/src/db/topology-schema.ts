import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import type { BuildDiagnostic, ExposureParams, NativeExposure, Settings } from '../topology/settings.ts';
import { globalAdmin, organisationAdmin, organisationMember, signedIn } from './roles.ts';
import { organisations } from './organisation-schema.ts';

// The stream topology an organisation owns: its networks, devices and the agents that run on them, its streams with
// their exposures and recorders, its provider registrations, and the subjects its agents report about.
//
// Every row binds to its organisation's scope through `organisation_id`, so `organisationMember` reads all of it and
// `organisationAdmin` manages it. Relationships between rows carry `organisation_id` in composite foreign keys, which
// keeps every reference inside one organisation in the database itself: an agent's network and host device, a
// stream's source device, an exposure's network and provider registration, and every entity's subject.

const topologyActions = {
  read: ['select'],
  create: ['insert'],
  edit: ['update'],
  remove: ['delete']
} as const;

const topologyRoles = {
  member: {
    label: 'Member',
    permissions: ['read'],
    assignableScopes: ['organisation'],
    includedIn: [organisationMember]
  },
  admin: {
    label: 'Administrator',
    permissions: ['read', 'create', 'edit', 'remove'],
    assignableScopes: ['organisation'],
    includedIn: [organisationAdmin]
  }
} as const;

/** The supported provider implementations, such as `cloudflare` or `moq`. Seeded by migration; every account reads them. */
export const providerTypes = withAccess(
  pgTable('provider_type', {
    id: text('id').primaryKey(),
    name: text('name').notNull()
  }),
  () => ({
    name: 'providerTypes',
    actions: { read: ['select'] },
    roles: {
      reader: {
        label: 'Reader',
        permissions: ['read'],
        assignableScopes: ['global'],
        includedIn: [signedIn]
      }
    }
  })
);

/**
 * A provider account or service the platform offers every organisation, such as the shared MoQ relay. Every account
 * reads them; global administrators manage them. Rate limits are stored as given: their policy is not settled.
 */
export const platformProviders = withAccess(
  pgTable('platform_provider_registration', {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    typeId: text('type_id')
      .notNull()
      .references(() => providerTypes.id),
    name: text('name').notNull(),
    params: jsonb('params').$type<Settings>().default({}).notNull(),
    credentialRefs: text('credential_refs').array().default([]).notNull(),
    rateLimits: jsonb('rate_limits').$type<Settings>().default({}).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull()
  }),
  t => ({
    name: 'platformProviders',
    immutable: [t.typeId, t.createdAt],
    actions: topologyActions,
    roles: {
      reader: {
        label: 'Reader',
        permissions: ['read'],
        assignableScopes: ['global'],
        includedIn: [signedIn]
      },
      maintainer: {
        label: 'Maintainer',
        permissions: ['read', 'create', 'edit', 'remove'],
        assignableScopes: ['global'],
        includedIn: [globalAdmin]
      }
    }
  })
);

/** A provider account or endpoint an organisation registers for itself. Credentials are references, never secrets. */
export const organisationProviders = withAccess(
  pgTable(
    'organisation_provider_registration',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      typeId: text('type_id')
        .notNull()
        .references(() => providerTypes.id),
      name: text('name').notNull(),
      params: jsonb('params').$type<Settings>().default({}).notNull(),
      credentialRefs: text('credential_refs').array().default([]).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [unique('organisation_provider_registration_organisation_id').on(t.organisationId, t.id)]
  ),
  t => ({
    name: 'organisationProviders',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.typeId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A stable identity for something observed: a topology entity (its `kind` names which) or an external target such as
 * a website. Observations, metrics, logs and derived state join on it; the label is only for display.
 */
export const subjects = withAccess(
  pgTable(
    'subject',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      kind: text('kind').notNull(),
      label: text('label'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [unique('subject_organisation_id').on(t.organisationId, t.id)]
  ),
  t => ({
    name: 'subjects',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.kind, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/** A managed network: one or more agents serve it, one of them active at a time. */
export const networks = withAccess(
  pgTable(
    'network',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      subjectId: uuid('subject_id').notNull().unique('network_subject'),
      name: text('name').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('network_organisation_id').on(t.organisationId, t.id),
      foreignKey({
        name: 'network_subject_fk',
        columns: [t.organisationId, t.subjectId],
        foreignColumns: [subjects.organisationId, subjects.id]
      })
    ]
  ),
  t => ({
    name: 'networks',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.subjectId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A camera, server or other device, on a managed network or (`network_id` null) the internet. `native_exposures` are
 * the endpoints it offers by itself, as opposed to the exposures streams manage.
 */
export const devices = withAccess(
  pgTable(
    'device',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      subjectId: uuid('subject_id').notNull().unique('device_subject'),
      type: text('type').notNull(),
      name: text('name').notNull(),
      networkId: uuid('network_id'),
      nativeExposures: jsonb('native_exposures').$type<NativeExposure[]>().default([]).notNull(),
      settings: jsonb('settings').$type<Settings>().default({}).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('device_organisation_id').on(t.organisationId, t.id),
      foreignKey({
        name: 'device_subject_fk',
        columns: [t.organisationId, t.subjectId],
        foreignColumns: [subjects.organisationId, subjects.id]
      }),
      foreignKey({
        name: 'device_network_fk',
        columns: [t.organisationId, t.networkId],
        foreignColumns: [networks.organisationId, networks.id]
      }),
      index('device_network_idx').on(t.networkId)
    ]
  ),
  t => ({
    name: 'devices',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.subjectId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * An agent serving one network from a host device of the same organisation. A network may have several for high
 * availability; at most one is active, which the partial unique index guarantees.
 */
export const agents = withAccess(
  pgTable(
    'agent',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      subjectId: uuid('subject_id').notNull().unique('agent_subject'),
      networkId: uuid('network_id').notNull(),
      deviceId: uuid('device_id').notNull(),
      priority: integer('priority').default(0).notNull(),
      active: boolean('active').default(false).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('agent_organisation_id').on(t.organisationId, t.id),
      foreignKey({
        name: 'agent_subject_fk',
        columns: [t.organisationId, t.subjectId],
        foreignColumns: [subjects.organisationId, subjects.id]
      }),
      foreignKey({
        name: 'agent_network_fk',
        columns: [t.organisationId, t.networkId],
        foreignColumns: [networks.organisationId, networks.id]
      }),
      foreignKey({
        name: 'agent_device_fk',
        columns: [t.organisationId, t.deviceId],
        foreignColumns: [devices.organisationId, devices.id]
      }),
      uniqueIndex('agent_network_active')
        .on(t.networkId)
        .where(sql`${t.active}`),
      index('agent_network_idx').on(t.networkId),
      index('agent_device_idx').on(t.deviceId)
    ]
  ),
  t => ({
    name: 'agents',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.subjectId, t.networkId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A rendered candidate configuration for an agent, with every diagnostic its builders reported. Candidates never
 * change; `served` marks the one the agent is given, at most one per agent, and never one with an error.
 */
export const configurationRevisions = withAccess(
  pgTable(
    'configuration_revision',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      agentId: uuid('agent_id').notNull(),
      config: jsonb('config').$type<Settings>().notNull(),
      diagnostics: jsonb('diagnostics').$type<BuildDiagnostic[]>().default([]).notNull(),
      hasErrors: boolean('has_errors')
        .generatedAlwaysAs(sql`jsonb_path_exists(diagnostics, '$[*] ? (@.severity == "error")')`)
        .notNull(),
      served: boolean('served').default(false).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      check('configuration_revision_served_usable', sql`not (${t.served} and ${t.hasErrors})`),
      foreignKey({
        name: 'configuration_revision_agent_fk',
        columns: [t.organisationId, t.agentId],
        foreignColumns: [agents.organisationId, agents.id]
      }).onDelete('cascade'),
      uniqueIndex('configuration_revision_agent_served')
        .on(t.agentId)
        .where(sql`${t.served}`),
      index('configuration_revision_agent_idx').on(t.agentId)
    ]
  ),
  t => ({
    name: 'configurationRevisions',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.agentId, t.config, t.diagnostics, t.createdAt],
    actions: { read: ['select'], create: ['insert'], serve: ['update'] },
    roles: {
      member: topologyRoles.member,
      admin: { ...topologyRoles.admin, permissions: ['read', 'create', 'serve'] }
    }
  })
);

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
      subjectId: uuid('subject_id').notNull().unique('stream_subject'),
      name: text('name').notNull(),
      sourceDeviceId: uuid('source_device_id'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('stream_organisation_id').on(t.organisationId, t.id),
      foreignKey({
        name: 'stream_subject_fk',
        columns: [t.organisationId, t.subjectId],
        foreignColumns: [subjects.organisationId, subjects.id]
      }),
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
    immutable: [t.subjectId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * How a stream is delivered: on a managed network or (`network_id` null) the internet, by a protocol, optionally
 * through a provider registration (the platform's or the organisation's own; at most one), with the renditions it
 * should offer in `params`. Paths and processes that realise it are derived by the configuration builders.
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
      subjectId: uuid('subject_id').notNull().unique('exposure_subject'),
      networkId: uuid('network_id'),
      protocol: text('protocol').notNull(),
      platformProviderId: uuid('platform_provider_id').references(() => platformProviders.id),
      organisationProviderId: uuid('organisation_provider_id'),
      params: jsonb('params').$type<ExposureParams>().default({}).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      check('exposure_one_provider', sql`num_nonnulls(${t.platformProviderId}, ${t.organisationProviderId}) <= 1`),
      unique('exposure_stream_id').on(t.streamId, t.id),
      foreignKey({
        name: 'exposure_stream_fk',
        columns: [t.organisationId, t.streamId],
        foreignColumns: [streams.organisationId, streams.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'exposure_subject_fk',
        columns: [t.organisationId, t.subjectId],
        foreignColumns: [subjects.organisationId, subjects.id]
      }),
      foreignKey({
        name: 'exposure_network_fk',
        columns: [t.organisationId, t.networkId],
        foreignColumns: [networks.organisationId, networks.id]
      }),
      foreignKey({
        name: 'exposure_organisation_provider_fk',
        columns: [t.organisationId, t.organisationProviderId],
        foreignColumns: [organisationProviders.organisationId, organisationProviders.id]
      }),
      index('exposure_network_idx').on(t.networkId),
      index('exposure_platform_provider_idx').on(t.platformProviderId),
      index('exposure_organisation_provider_idx').on(t.organisationProviderId)
    ]
  ),
  t => ({
    name: 'exposures',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.streamId, t.subjectId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A recording responsibility, always backed by an exposure of its own stream: that exposure supplies the network and
 * provider. An exposure a recorder uses cannot be deleted from under it.
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

/**
 * A resource provisioned through a provider registration, such as a Cloudflare live input, owned by the organisation
 * it was provisioned for. Exactly one registration: the platform's or the organisation's own.
 */
export const providerResources = withAccess(
  pgTable(
    'provider_resource',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      platformProviderId: uuid('platform_provider_id').references(() => platformProviders.id),
      organisationProviderId: uuid('organisation_provider_id'),
      kind: text('kind').notNull(),
      externalId: text('external_id').notNull(),
      params: jsonb('params').$type<Settings>().default({}).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      check(
        'provider_resource_one_provider',
        sql`num_nonnulls(${t.platformProviderId}, ${t.organisationProviderId}) = 1`
      ),
      foreignKey({
        name: 'provider_resource_organisation_provider_fk',
        columns: [t.organisationId, t.organisationProviderId],
        foreignColumns: [organisationProviders.organisationId, organisationProviders.id]
      }),
      index('provider_resource_organisation_idx').on(t.organisationId),
      index('provider_resource_platform_provider_idx').on(t.platformProviderId),
      index('provider_resource_organisation_provider_idx').on(t.organisationProviderId)
    ]
  ),
  t => ({
    name: 'providerResources',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.platformProviderId, t.organisationProviderId, t.kind, t.externalId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);
