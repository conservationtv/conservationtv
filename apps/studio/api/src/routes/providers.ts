import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { organisationProviders, platformProviders, providerResources, providerTypes } from '../db/schema.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useServices } from '../services.ts';
import { providerColumns } from '../topology/providers.ts';
import { SettingsSchema } from '../topology/settings.ts';
import { unchanged } from '../topology/transaction.ts';
import {
  forbidden,
  inUse,
  invalidReference,
  invalidRequest,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const OrganisationProviderParamsSchema = OrganisationParamsSchema.extend({
  providerId: z.uuid().describe("One of the organisation's provider registrations.")
});
export type OrganisationProviderParams = z.output<typeof OrganisationProviderParamsSchema>;
const PlatformProviderParamsSchema = z.object({ providerId: z.uuid().describe('A platform provider registration.') });
export type PlatformProviderParams = z.output<typeof PlatformProviderParamsSchema>;
const ResourceParamsSchema = OrganisationParamsSchema.extend({
  resourceId: z.uuid().describe('The provider resource.')
});
export type ResourceParams = z.output<typeof ResourceParamsSchema>;

const ProviderNameSchema = z.string().trim().min(1).max(120).describe('The registration name.');
export type ProviderName = z.output<typeof ProviderNameSchema>;
const CredentialRefsSchema = z
  .array(z.string().min(1).max(200))
  .max(16)
  .describe('References to the credentials the registration uses, never the secrets themselves.');
export type CredentialRefs = z.output<typeof CredentialRefsSchema>;

// Provider types are the supported implementations; a registration is a configured instance of one: either offered
// by the platform to every organisation (read by every account, managed by global administrators) or an
// organisation's own (read by its members, managed by its administrators). Provider resources are what an
// organisation has provisioned through a registration; their `providerId` is whichever registration column is set.
// All of it runs in the principal's request session.
export default new Hono()
  .get(
    '/provider-types',
    describeRoute({
      operationId: 'providerTypes.list',
      ...operationVersion(1),
      summary: 'List the supported provider types',
      responses: {
        200: { description: 'The provider types' },
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    async c => {
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx.select({ id: providerTypes.id, name: providerTypes.name }).from(providerTypes).orderBy(providerTypes.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ providerTypes: rows }, 200);
    }
  )
  .get(
    '/providers',
    describeRoute({
      operationId: 'platformProviders.list',
      ...operationVersion(1),
      summary: 'List the platform provider registrations',
      description: 'The provider accounts and services the platform offers every organisation.',
      responses: {
        200: { description: 'The registrations, oldest first' },
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    async c => {
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: platformProviders.id,
            typeId: platformProviders.typeId,
            name: platformProviders.name,
            params: platformProviders.params,
            credentialRefs: platformProviders.credentialRefs,
            rateLimits: platformProviders.rateLimits,
            createdAt: platformProviders.createdAt
          })
          .from(platformProviders)
          .orderBy(platformProviders.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ providers: rows }, 200);
    }
  )
  .post(
    '/providers',
    describeRoute({
      operationId: 'platformProviders.create',
      ...operationVersion(1),
      summary: 'Register a platform provider',
      description: 'Global administrators only. Offers a provider account or service to every organisation.',
      responses: {
        201: { description: 'The new registration' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator(
      'json',
      z.strictObject({
        typeId: z.string().min(1).max(60).describe('The provider type.'),
        name: ProviderNameSchema,
        params: SettingsSchema.default({}),
        credentialRefs: CredentialRefsSchema.default([]),
        rateLimits: SettingsSchema.default({}).describe('The limits applied to each organisation using it.')
      })
    ),
    async c => {
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(tx =>
        tx
          .insert(platformProviders)
          .values({
            typeId: body.typeId,
            name: body.name,
            params: body.params,
            credentialRefs: body.credentialRefs,
            rateLimits: body.rateLimits
          })
          .returning({
            id: platformProviders.id,
            typeId: platformProviders.typeId,
            name: platformProviders.name,
            params: platformProviders.params,
            credentialRefs: platformProviders.credentialRefs,
            rateLimits: platformProviders.rateLimits,
            createdAt: platformProviders.createdAt
          })
      );
      c.header('Cache-Control', 'no-store');
      return c.json(row!, 201);
    }
  )
  .patch(
    '/providers/:providerId',
    describeRoute({
      operationId: 'platformProviders.update',
      ...operationVersion(1),
      summary: 'Update a platform provider',
      description: 'Global administrators only. Changes only the fields given; objects are replaced whole.',
      responses: {
        200: { description: 'The updated registration' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', PlatformProviderParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          name: ProviderNameSchema.optional(),
          params: SettingsSchema.optional(),
          credentialRefs: CredentialRefsSchema.optional(),
          rateLimits: SettingsSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { providerId } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const [provider] = await tx
          .update(platformProviders)
          .set({
            name: body.name,
            params: body.params,
            credentialRefs: body.credentialRefs,
            rateLimits: body.rateLimits
          })
          .where(eq(platformProviders.id, providerId))
          .returning({
            id: platformProviders.id,
            typeId: platformProviders.typeId,
            name: platformProviders.name,
            params: platformProviders.params,
            credentialRefs: platformProviders.credentialRefs,
            rateLimits: platformProviders.rateLimits,
            createdAt: platformProviders.createdAt
          });
        if (!provider) throw await unchanged(tx, platformProviders.id, providerId);
        return provider;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/providers/:providerId',
    describeRoute({
      operationId: 'platformProviders.delete',
      ...operationVersion(1),
      summary: 'Remove a platform provider',
      description: 'Global administrators only. Refused while any exposure or provider resource uses it.',
      responses: {
        204: { description: 'Removed' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: inUse,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', PlatformProviderParamsSchema),
    async c => {
      const { providerId } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(platformProviders)
          .where(eq(platformProviders.id, providerId))
          .returning({ id: platformProviders.id });
        if (deleted.length === 0) throw await unchanged(tx, platformProviders.id, providerId);
      });
      return c.body(null, 204);
    }
  )
  .get(
    '/organisations/:id/providers',
    describeRoute({
      operationId: 'organisations.providers.list',
      ...operationVersion(1),
      summary: 'List the providers an organisation can use',
      description:
        "The platform's registrations (`scope: platform`) and the organisation's own (`scope: organisation`), which only its members see. Exposures and provider resources name either by ID.",
      responses: {
        200: { description: "The platform's registrations, then the organisation's, each oldest first" },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [platform, own] = await session.transaction(async tx => [
        await tx
          .select({
            id: platformProviders.id,
            scope: sql<'platform' | 'organisation'>`'platform'`,
            typeId: platformProviders.typeId,
            name: platformProviders.name,
            params: platformProviders.params,
            credentialRefs: platformProviders.credentialRefs,
            createdAt: platformProviders.createdAt
          })
          .from(platformProviders)
          .orderBy(platformProviders.id),
        await tx
          .select({
            id: organisationProviders.id,
            scope: sql<'platform' | 'organisation'>`'organisation'`,
            typeId: organisationProviders.typeId,
            name: organisationProviders.name,
            params: organisationProviders.params,
            credentialRefs: organisationProviders.credentialRefs,
            createdAt: organisationProviders.createdAt
          })
          .from(organisationProviders)
          .where(eq(organisationProviders.organisationId, id))
          .orderBy(organisationProviders.id)
      ]);
      c.header('Cache-Control', 'no-store');
      return c.json({ providers: [...platform, ...own] }, 200);
    }
  )
  .post(
    '/organisations/:id/providers',
    describeRoute({
      operationId: 'organisations.providers.create',
      ...operationVersion(1),
      summary: 'Register a provider for an organisation',
      description: 'Administrators only. Configures an account or endpoint of a supported provider type.',
      responses: {
        201: { description: 'The new registration' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z.strictObject({
        typeId: z.string().min(1).max(60).describe('The provider type.'),
        name: ProviderNameSchema,
        params: SettingsSchema.default({}),
        credentialRefs: CredentialRefsSchema.default([])
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(tx =>
        tx
          .insert(organisationProviders)
          .values({
            organisationId: id,
            typeId: body.typeId,
            name: body.name,
            params: body.params,
            credentialRefs: body.credentialRefs
          })
          .returning({
            id: organisationProviders.id,
            scope: sql<'organisation'>`'organisation'`,
            typeId: organisationProviders.typeId,
            name: organisationProviders.name,
            params: organisationProviders.params,
            credentialRefs: organisationProviders.credentialRefs,
            createdAt: organisationProviders.createdAt
          })
      );
      c.header('Cache-Control', 'no-store');
      return c.json(row!, 201);
    }
  )
  .patch(
    '/organisations/:id/providers/:providerId',
    describeRoute({
      operationId: 'organisations.providers.update',
      ...operationVersion(1),
      summary: "Update an organisation's provider registration",
      description: 'Administrators only. Changes only the fields given; `params` is replaced whole.',
      responses: {
        200: { description: 'The updated registration' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationProviderParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          name: ProviderNameSchema.optional(),
          params: SettingsSchema.optional(),
          credentialRefs: CredentialRefsSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, providerId } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const [provider] = await tx
          .update(organisationProviders)
          .set({ name: body.name, params: body.params, credentialRefs: body.credentialRefs })
          .where(and(eq(organisationProviders.organisationId, id), eq(organisationProviders.id, providerId)))
          .returning({
            id: organisationProviders.id,
            scope: sql<'organisation'>`'organisation'`,
            typeId: organisationProviders.typeId,
            name: organisationProviders.name,
            params: organisationProviders.params,
            credentialRefs: organisationProviders.credentialRefs,
            createdAt: organisationProviders.createdAt
          });
        if (!provider) throw await unchanged(tx, organisationProviders.id, providerId);
        return provider;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/organisations/:id/providers/:providerId',
    describeRoute({
      operationId: 'organisations.providers.delete',
      ...operationVersion(1),
      summary: "Remove an organisation's provider registration",
      description: 'Administrators only. Refused while any exposure or provider resource uses it.',
      responses: {
        204: { description: 'Removed' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: inUse,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationProviderParamsSchema),
    async c => {
      const { id, providerId } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(organisationProviders)
          .where(and(eq(organisationProviders.organisationId, id), eq(organisationProviders.id, providerId)))
          .returning({ id: organisationProviders.id });
        if (deleted.length === 0) throw await unchanged(tx, organisationProviders.id, providerId);
      });
      return c.body(null, 204);
    }
  )
  .get(
    '/organisations/:id/provider-resources',
    describeRoute({
      operationId: 'organisations.providerResources.list',
      ...operationVersion(1),
      summary: "List an organisation's provider resources",
      description: 'Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The resources, oldest first' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: providerResources.id,
            providerId: sql<string>`coalesce(${providerResources.platformProviderId}, ${providerResources.organisationProviderId})`,
            kind: providerResources.kind,
            externalId: providerResources.externalId,
            params: providerResources.params,
            createdAt: providerResources.createdAt
          })
          .from(providerResources)
          .where(eq(providerResources.organisationId, id))
          .orderBy(providerResources.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ providerResources: rows }, 200);
    }
  )
  .post(
    '/organisations/:id/provider-resources',
    describeRoute({
      operationId: 'organisations.providerResources.create',
      ...operationVersion(1),
      summary: 'Record a provider resource',
      description:
        'Administrators only. A resource provisioned for the organisation through a provider registration, such as a live input, identified by its ID at the provider.',
      responses: {
        201: { description: 'The recorded resource' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z.strictObject({
        providerId: z
          .uuid()
          .describe("The registration it was provisioned through: the platform's or the organisation's."),
        kind: z.string().trim().min(1).max(60).describe('What it is, such as `liveInput`.'),
        externalId: z.string().min(1).max(200).describe("The resource's ID at the provider."),
        params: SettingsSchema.default({})
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(async tx =>
        tx
          .insert(providerResources)
          .values({
            organisationId: id,
            ...(await providerColumns(tx, id, body.providerId)),
            kind: body.kind,
            externalId: body.externalId,
            params: body.params
          })
          .returning({
            id: providerResources.id,
            providerId: sql<string>`coalesce(${providerResources.platformProviderId}, ${providerResources.organisationProviderId})`,
            kind: providerResources.kind,
            externalId: providerResources.externalId,
            params: providerResources.params,
            createdAt: providerResources.createdAt
          })
      );
      c.header('Cache-Control', 'no-store');
      return c.json(row!, 201);
    }
  )
  .patch(
    '/organisations/:id/provider-resources/:resourceId',
    describeRoute({
      operationId: 'organisations.providerResources.update',
      ...operationVersion(1),
      summary: "Update a provider resource's settings",
      description: 'Administrators only. Its registration, kind and external ID never change.',
      responses: {
        200: { description: 'The updated resource' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ResourceParamsSchema),
    validator('json', z.strictObject({ params: SettingsSchema })),
    async c => {
      const { id, resourceId } = c.req.valid('param');
      const { params } = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const [resource] = await tx
          .update(providerResources)
          .set({ params })
          .where(and(eq(providerResources.organisationId, id), eq(providerResources.id, resourceId)))
          .returning({
            id: providerResources.id,
            providerId: sql<string>`coalesce(${providerResources.platformProviderId}, ${providerResources.organisationProviderId})`,
            kind: providerResources.kind,
            externalId: providerResources.externalId,
            params: providerResources.params,
            createdAt: providerResources.createdAt
          });
        if (!resource) throw await unchanged(tx, providerResources.id, resourceId);
        return resource;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/organisations/:id/provider-resources/:resourceId',
    describeRoute({
      operationId: 'organisations.providerResources.delete',
      ...operationVersion(1),
      summary: 'Forget a provider resource',
      description: 'Administrators only. Removes the record; deprovisioning at the provider is separate.',
      responses: {
        204: { description: 'Removed' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ResourceParamsSchema),
    async c => {
      const { id, resourceId } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(providerResources)
          .where(and(eq(providerResources.organisationId, id), eq(providerResources.id, resourceId)))
          .returning({ id: providerResources.id });
        if (deleted.length === 0) throw await unchanged(tx, providerResources.id, resourceId);
      });
      return c.body(null, 204);
    }
  );
