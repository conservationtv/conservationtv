import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { exposures, recorders, streams, subjects } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useServices } from '../services.ts';
import { providerColumns } from '../topology/providers.ts';
import { ExposureParamsSchema, NetworkReferenceSchema, SettingsSchema } from '../topology/settings.ts';
import { newSubject, unchanged } from '../topology/transaction.ts';
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
const StreamParamsSchema = OrganisationParamsSchema.extend({ streamId: z.uuid().describe('The stream.') });
export type StreamParams = z.output<typeof StreamParamsSchema>;
const ExposurePathParamsSchema = StreamParamsSchema.extend({ exposureId: z.uuid().describe('The exposure.') });
export type ExposurePathParams = z.output<typeof ExposurePathParamsSchema>;
const RecorderParamsSchema = StreamParamsSchema.extend({ recorderId: z.uuid().describe('The recorder.') });
export type RecorderParams = z.output<typeof RecorderParamsSchema>;

const StreamNameSchema = z.string().trim().min(1).max(120).describe('The stream name.');
export type StreamName = z.output<typeof StreamNameSchema>;
const SourceDeviceSchema = z
  .uuid()
  .nullable()
  .describe('The device the stream comes from, such as its camera, or null for none yet.');
export type SourceDevice = z.output<typeof SourceDeviceSchema>;
const ProtocolSchema = z.string().trim().min(1).max(60).describe('The delivery protocol, such as `moq` or `rtsp`.');
export type Protocol = z.output<typeof ProtocolSchema>;
const ProviderReferenceSchema = z
  .uuid()
  .nullable()
  .describe("A provider registration, the platform's or the organisation's own, or null for a local exposure.");
export type ProviderReference = z.output<typeof ProviderReferenceSchema>;
const RecorderKindSchema = z.string().trim().min(1).max(60).describe('The recording implementation.');
export type RecorderKind = z.output<typeof RecorderKindSchema>;

// An organisation's streams, with their exposures and recorders, in the principal's request session: members read
// them, administrators manage them. A stream's source device, an exposure's network and provider, and a recorder's
// exposure must belong to the same organisation (and a recorder's exposure to the same stream); the database's
// composite foreign keys refuse anything else. Streams and exposures each have a subject of their own. An exposure's
// `providerId` is whichever of its two registration columns is set.
export default new Hono()
  .get(
    '/:id/streams',
    describeRoute({
      operationId: 'organisations.streams.list',
      ...operationVersion(1),
      summary: "List an organisation's streams",
      description: 'Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The streams, oldest first' },
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
      const session = await useServices().session(usePrincipal());
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: streams.id,
            subjectId: streams.subjectId,
            name: streams.name,
            sourceDeviceId: streams.sourceDeviceId,
            createdAt: streams.createdAt
          })
          .from(streams)
          .where(eq(streams.organisationId, id))
          .orderBy(streams.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ streams: rows }, 200);
    }
  )
  .post(
    '/:id/streams',
    describeRoute({
      operationId: 'organisations.streams.create',
      ...operationVersion(1),
      summary: 'Create a stream',
      description: 'Administrators only. The stream gets a subject of its own.',
      responses: {
        201: { description: 'The new stream' },
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
    validator('json', z.strictObject({ name: StreamNameSchema, sourceDeviceId: SourceDeviceSchema.default(null) })),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const session = await useServices().session(usePrincipal());
      const [row] = await session.transaction(async tx =>
        tx
          .insert(streams)
          .values({
            organisationId: id,
            subjectId: await newSubject(tx, id, 'stream', body.name),
            name: body.name,
            sourceDeviceId: body.sourceDeviceId
          })
          .returning({
            id: streams.id,
            subjectId: streams.subjectId,
            name: streams.name,
            sourceDeviceId: streams.sourceDeviceId,
            createdAt: streams.createdAt
          })
      );
      c.header('Cache-Control', 'no-store');
      return c.json(row!, 201);
    }
  )
  .get(
    '/:id/streams/:streamId',
    describeRoute({
      operationId: 'organisations.streams.get',
      ...operationVersion(1),
      summary: 'Read a stream',
      description: 'With its exposures and recorders.',
      responses: {
        200: { description: 'The stream' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', StreamParamsSchema),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const session = await useServices().session(usePrincipal());
      const row = await session.transaction(async tx => {
        const [stream] = await tx
          .select({
            id: streams.id,
            subjectId: streams.subjectId,
            name: streams.name,
            sourceDeviceId: streams.sourceDeviceId,
            createdAt: streams.createdAt
          })
          .from(streams)
          .where(and(eq(streams.organisationId, id), eq(streams.id, streamId)));
        if (!stream) throw new ApiFailure('not_found');
        return {
          ...stream,
          exposures: await tx
            .select({
              id: exposures.id,
              subjectId: exposures.subjectId,
              networkId: exposures.networkId,
              protocol: exposures.protocol,
              providerId: sql<
                string | null
              >`coalesce(${exposures.platformProviderId}, ${exposures.organisationProviderId})`,
              params: exposures.params,
              createdAt: exposures.createdAt
            })
            .from(exposures)
            .where(eq(exposures.streamId, streamId))
            .orderBy(exposures.id),
          recorders: await tx
            .select({
              id: recorders.id,
              exposureId: recorders.exposureId,
              kind: recorders.kind,
              params: recorders.params,
              createdAt: recorders.createdAt
            })
            .from(recorders)
            .where(eq(recorders.streamId, streamId))
            .orderBy(recorders.id)
        };
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:id/streams/:streamId',
    describeRoute({
      operationId: 'organisations.streams.update',
      ...operationVersion(1),
      summary: 'Update a stream',
      description:
        "Administrators only: rename it (relabelling its subject too), or change its source device. The stream's identity stays the same when its camera changes.",
      responses: {
        200: { description: 'The updated stream, without its exposures and recorders' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', StreamParamsSchema),
    validator(
      'json',
      z
        .strictObject({ name: StreamNameSchema.optional(), sourceDeviceId: SourceDeviceSchema.optional() })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const body = c.req.valid('json');
      const session = await useServices().session(usePrincipal());
      const row = await session.transaction(async tx => {
        const [stream] = await tx
          .update(streams)
          .set({ name: body.name, sourceDeviceId: body.sourceDeviceId })
          .where(and(eq(streams.organisationId, id), eq(streams.id, streamId)))
          .returning({
            id: streams.id,
            subjectId: streams.subjectId,
            name: streams.name,
            sourceDeviceId: streams.sourceDeviceId,
            createdAt: streams.createdAt
          });
        if (!stream) throw await unchanged(tx, streams.id, streamId);
        if (body.name !== undefined)
          await tx.update(subjects).set({ label: body.name }).where(eq(subjects.id, stream.subjectId));
        return stream;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id/streams/:streamId',
    describeRoute({
      operationId: 'organisations.streams.delete',
      ...operationVersion(1),
      summary: 'Delete a stream',
      description:
        'Administrators only, with its exposures and recorders. Their subjects remain until the subjects are deleted.',
      responses: {
        204: { description: 'Deleted' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', StreamParamsSchema),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const session = await useServices().session(usePrincipal());
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(streams)
          .where(and(eq(streams.organisationId, id), eq(streams.id, streamId)))
          .returning({ id: streams.id });
        if (deleted.length === 0) throw await unchanged(tx, streams.id, streamId);
      });
      return c.body(null, 204);
    }
  )
  .post(
    '/:id/streams/:streamId/exposures',
    describeRoute({
      operationId: 'organisations.streams.exposures.create',
      ...operationVersion(1),
      summary: 'Expose a stream',
      description:
        'Administrators only. Declares how the stream is delivered: where, by which protocol, through which provider registration, and the renditions it should offer. The exposure gets a subject of its own.',
      responses: {
        201: { description: 'The new exposure' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', StreamParamsSchema),
    validator(
      'json',
      z.strictObject({
        networkId: NetworkReferenceSchema.default(null),
        protocol: ProtocolSchema,
        providerId: ProviderReferenceSchema.default(null),
        params: ExposureParamsSchema.default({})
      })
    ),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const body = c.req.valid('json');
      const session = await useServices().session(usePrincipal());
      const row = await session.transaction(async tx => {
        const [stream] = await tx
          .select({ id: streams.id })
          .from(streams)
          .where(and(eq(streams.organisationId, id), eq(streams.id, streamId)));
        if (!stream) throw new ApiFailure('not_found');
        const [exposure] = await tx
          .insert(exposures)
          .values({
            organisationId: id,
            streamId,
            subjectId: await newSubject(tx, id, 'exposure', body.protocol),
            networkId: body.networkId,
            protocol: body.protocol,
            ...(await providerColumns(tx, id, body.providerId)),
            params: body.params
          })
          .returning({
            id: exposures.id,
            subjectId: exposures.subjectId,
            networkId: exposures.networkId,
            protocol: exposures.protocol,
            providerId: sql<
              string | null
            >`coalesce(${exposures.platformProviderId}, ${exposures.organisationProviderId})`,
            params: exposures.params,
            createdAt: exposures.createdAt
          });
        return exposure!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .patch(
    '/:id/streams/:streamId/exposures/:exposureId',
    describeRoute({
      operationId: 'organisations.streams.exposures.update',
      ...operationVersion(1),
      summary: 'Update an exposure',
      description: 'Administrators only. Changes only the fields given; `params` is replaced whole.',
      responses: {
        200: { description: 'The updated exposure' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ExposurePathParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          networkId: NetworkReferenceSchema.optional(),
          protocol: ProtocolSchema.optional(),
          providerId: ProviderReferenceSchema.optional(),
          params: ExposureParamsSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, streamId, exposureId } = c.req.valid('param');
      const body = c.req.valid('json');
      const session = await useServices().session(usePrincipal());
      const row = await session.transaction(async tx => {
        const provider = body.providerId === undefined ? undefined : await providerColumns(tx, id, body.providerId);
        const [exposure] = await tx
          .update(exposures)
          .set({ networkId: body.networkId, protocol: body.protocol, ...provider, params: body.params })
          .where(and(eq(exposures.organisationId, id), eq(exposures.streamId, streamId), eq(exposures.id, exposureId)))
          .returning({
            id: exposures.id,
            subjectId: exposures.subjectId,
            networkId: exposures.networkId,
            protocol: exposures.protocol,
            providerId: sql<
              string | null
            >`coalesce(${exposures.platformProviderId}, ${exposures.organisationProviderId})`,
            params: exposures.params,
            createdAt: exposures.createdAt
          });
        if (!exposure) throw await unchanged(tx, exposures.id, exposureId);
        return exposure;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id/streams/:streamId/exposures/:exposureId',
    describeRoute({
      operationId: 'organisations.streams.exposures.delete',
      ...operationVersion(1),
      summary: 'Remove an exposure',
      description:
        'Administrators only. Refused while a recorder uses it. Its subject remains until the subject is deleted.',
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
    validator('param', ExposurePathParamsSchema),
    async c => {
      const { id, streamId, exposureId } = c.req.valid('param');
      const session = await useServices().session(usePrincipal());
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(exposures)
          .where(and(eq(exposures.organisationId, id), eq(exposures.streamId, streamId), eq(exposures.id, exposureId)))
          .returning({ id: exposures.id });
        if (deleted.length === 0) throw await unchanged(tx, exposures.id, exposureId);
      });
      return c.body(null, 204);
    }
  )
  .post(
    '/:id/streams/:streamId/recorders',
    describeRoute({
      operationId: 'organisations.streams.recorders.create',
      ...operationVersion(1),
      summary: 'Record a stream',
      description:
        "Administrators only. Recording is always backed by one of the stream's exposures, which supplies its network and provider: a stream recorded by a provider needs an exposure on that provider.",
      responses: {
        201: { description: 'The new recorder' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', StreamParamsSchema),
    validator(
      'json',
      z.strictObject({
        exposureId: z.uuid().describe('The exposure of this stream to record.'),
        kind: RecorderKindSchema,
        params: SettingsSchema.default({})
      })
    ),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const body = c.req.valid('json');
      const session = await useServices().session(usePrincipal());
      const row = await session.transaction(async tx => {
        const [stream] = await tx
          .select({ id: streams.id })
          .from(streams)
          .where(and(eq(streams.organisationId, id), eq(streams.id, streamId)));
        if (!stream) throw new ApiFailure('not_found');
        const [recorder] = await tx
          .insert(recorders)
          .values({ organisationId: id, streamId, exposureId: body.exposureId, kind: body.kind, params: body.params })
          .returning({
            id: recorders.id,
            exposureId: recorders.exposureId,
            kind: recorders.kind,
            params: recorders.params,
            createdAt: recorders.createdAt
          });
        return recorder!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .patch(
    '/:id/streams/:streamId/recorders/:recorderId',
    describeRoute({
      operationId: 'organisations.streams.recorders.update',
      ...operationVersion(1),
      summary: 'Update a recorder',
      description: 'Administrators only. Changes only the fields given; `params` is replaced whole.',
      responses: {
        200: { description: 'The updated recorder' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', RecorderParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          exposureId: z.uuid().optional().describe('The exposure of this stream to record.'),
          kind: RecorderKindSchema.optional(),
          params: SettingsSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, streamId, recorderId } = c.req.valid('param');
      const body = c.req.valid('json');
      const session = await useServices().session(usePrincipal());
      const row = await session.transaction(async tx => {
        const [recorder] = await tx
          .update(recorders)
          .set({ exposureId: body.exposureId, kind: body.kind, params: body.params })
          .where(and(eq(recorders.organisationId, id), eq(recorders.streamId, streamId), eq(recorders.id, recorderId)))
          .returning({
            id: recorders.id,
            exposureId: recorders.exposureId,
            kind: recorders.kind,
            params: recorders.params,
            createdAt: recorders.createdAt
          });
        if (!recorder) throw await unchanged(tx, recorders.id, recorderId);
        return recorder;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id/streams/:streamId/recorders/:recorderId',
    describeRoute({
      operationId: 'organisations.streams.recorders.delete',
      ...operationVersion(1),
      summary: 'Remove a recorder',
      description: 'Administrators only.',
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
    validator('param', RecorderParamsSchema),
    async c => {
      const { id, streamId, recorderId } = c.req.valid('param');
      const session = await useServices().session(usePrincipal());
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(recorders)
          .where(and(eq(recorders.organisationId, id), eq(recorders.streamId, streamId), eq(recorders.id, recorderId)))
          .returning({ id: recorders.id });
        if (deleted.length === 0) throw await unchanged(tx, recorders.id, recorderId);
      });
      return c.body(null, 204);
    }
  );
