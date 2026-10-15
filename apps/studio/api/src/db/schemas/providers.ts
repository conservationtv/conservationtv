import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { Settings } from '../../topology/settings.ts';
import { globalAdmin, signedIn } from '../roles.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

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
