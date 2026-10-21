import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { connect, deviceRequest, memberRequest, type ExposureReference } from '../gateways/connect.ts';
import { ConnectionActionSchema, type ConnectionAction } from '../gateways/provider.ts';
import { exposures, recorders, streams } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requireCaller, useCaller, useDevice } from '../middleware/device.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useEnvironment } from '../env/env.ts';
import { checkChain, checkGateway, checkRecorderRendition, checkRenditions } from '../topology/exposures.ts';
import { ExposureParamsSchema, RenditionSchema, RenditionsSchema, SettingsSchema } from '../topology/settings.ts';
import { unchanged } from '../topology/transaction.ts';
import { GatewayIdSchema } from './gateways.ts';
import {
  connectionRefused,
  forbidden,
  gatewayUnavailable,
  inUse,
  exposureInUse,
  invalidExposureReference,
  invalidRecorderReference,
  invalidReference,
  invalidRequest,
  noCaller,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  unsupportedConnection,
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
const GatewaySchema = GatewayIdSchema.describe(
  "The gateway the stream is delivered to: built in, or the organisation's own."
);
export type Gateway = z.output<typeof GatewaySchema>;
const PublisherDeviceSchema = z
  .uuid()
  .nullable()
  .describe('The device that publishes the exposure to its gateway, or null for whichever the system chooses.');
export type PublisherDevice = z.output<typeof PublisherDeviceSchema>;
const UpstreamExposureSchema = z
  .uuid()
  .nullable()
  .describe("An exposure of the same stream to publish from, or null for the stream's source device.");
export type UpstreamExposure = z.output<typeof UpstreamExposureSchema>;
const RecordedRenditionSchema = RenditionSchema.describe('The rendition of the exposure to record: one it offers.');
export type RecordedRendition = z.output<typeof RecordedRenditionSchema>;
const ConnectionProtocolSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe('One of the protocols the gateway is read by (to read), or published to (to publish), such as `webrtc`.');
export type ConnectionProtocol = z.output<typeof ConnectionProtocolSchema>;
const ConnectionRenditionSchema = RenditionSchema.optional().describe(
  'The rendition to connect to, for a protocol that carries one per connection (any but `moq`); optional when the exposure offers only one. With `moq`, every rendition is a track of the one connection.'
);
export type ConnectionRendition = z.output<typeof ConnectionRenditionSchema>;
const ExposureChangesSchema = z
  .strictObject({
    gatewayId: GatewaySchema.optional(),
    renditions: RenditionsSchema.optional(),
    publisherDeviceId: PublisherDeviceSchema.optional(),
    upstreamExposureId: UpstreamExposureSchema.optional(),
    params: ExposureParamsSchema.optional()
  })
  .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change');
type ExposureChanges = z.output<typeof ExposureChangesSchema>;
const RecorderKindSchema = z.string().trim().min(1).max(60).describe('The recording implementation.');
export type RecorderKind = z.output<typeof RecorderKindSchema>;

// An organisation's streams, with their exposures and recorders, in the principal's request session: members read
// them, administrators manage them. A stream's source device, an exposure's gateway and publisher, and a recorder's
// exposure must belong to the same organisation (and an exposure's upstream and a recorder's exposure to the same
// stream); the database's composite foreign keys refuse anything else. What they cannot check, an exposure's gateway
// (which may be built in), its upstream chain and the renditions along it, src/topology/exposures.ts does.

const exposureColumns = {
  id: exposures.id,
  gatewayId: exposures.gatewayId,
  renditions: exposures.renditions,
  publisherDeviceId: exposures.publisherDeviceId,
  upstreamExposureId: exposures.upstreamExposureId,
  params: exposures.params,
  createdAt: exposures.createdAt
};

const recorderColumns = {
  id: recorders.id,
  exposureId: recorders.exposureId,
  rendition: recorders.rendition,
  kind: recorders.kind,
  params: recorders.params,
  createdAt: recorders.createdAt
};

/** Whether a change to an exposure touches the renditions along its chain: its own, or its upstream. */
function changesRenditions(changes: ExposureChanges) {
  return changes.renditions !== undefined || changes.upstreamExposureId !== undefined;
}

/** A signing device's connection request. */
function asDevice(reference: ExposureReference, action: ConnectionAction) {
  const device = useDevice();
  return deviceRequest(device, reference, action);
}

/** A signed-in member's connection request. */
function asMember(reference: ExposureReference, action: ConnectionAction) {
  const principal = usePrincipal();
  return memberRequest(principal, reference, action);
}

export default new Hono()
  .get(
    '/',
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
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: streams.id,
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
    '/',
    describeRoute({
      operationId: 'organisations.streams.create',
      ...operationVersion(1),
      summary: 'Create a stream',
      description: 'Administrators only.',
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
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const [row] = await session.transaction(async tx =>
        tx
          .insert(streams)
          .values({
            organisationId: id,
            name: body.name,
            sourceDeviceId: body.sourceDeviceId
          })
          .returning({
            id: streams.id,
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
    '/:streamId',
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
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(tx =>
        tx.query.streams.findFirst({
          columns: { id: true, name: true, sourceDeviceId: true, createdAt: true },
          where: { organisationId: id, id: streamId },
          with: {
            exposures: {
              columns: {
                id: true,
                gatewayId: true,
                renditions: true,
                publisherDeviceId: true,
                upstreamExposureId: true,
                params: true,
                createdAt: true
              },
              orderBy: { id: 'asc' }
            },
            recorders: {
              columns: { id: true, exposureId: true, rendition: true, kind: true, params: true, createdAt: true },
              orderBy: { id: 'asc' }
            }
          }
        })
      );
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:streamId',
    describeRoute({
      operationId: 'organisations.streams.update',
      ...operationVersion(1),
      summary: 'Update a stream',
      description:
        "Administrators only: rename it, or change its source device. The stream's identity stays the same when its camera changes.",
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
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(async tx => {
        const [stream] = await tx
          .update(streams)
          .set({ name: body.name, sourceDeviceId: body.sourceDeviceId })
          .where(and(eq(streams.organisationId, id), eq(streams.id, streamId)))
          .returning({
            id: streams.id,
            name: streams.name,
            sourceDeviceId: streams.sourceDeviceId,
            createdAt: streams.createdAt
          });
        if (!stream) throw await unchanged(tx, streams.id, streamId);
        return stream;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:streamId',
    describeRoute({
      operationId: 'organisations.streams.delete',
      ...operationVersion(1),
      summary: 'Delete a stream',
      description: 'Administrators only, with its exposures and recorders.',
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
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
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
    '/:streamId/exposures',
    describeRoute({
      operationId: 'organisations.streams.exposures.create',
      ...operationVersion(1),
      summary: 'Expose a stream',
      description:
        'Administrators only. Declares how the stream is delivered: to which gateway, by which publisher from which upstream, offering which renditions (at most those its upstream offers). The gateway decides the protocols it is read by.',
      responses: {
        201: { description: 'The new exposure' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidExposureReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', StreamParamsSchema),
    validator(
      'json',
      z.strictObject({
        gatewayId: GatewaySchema,
        renditions: RenditionsSchema.default(['default']),
        publisherDeviceId: PublisherDeviceSchema.default(null),
        upstreamExposureId: UpstreamExposureSchema.default(null),
        params: ExposureParamsSchema.default({})
      })
    ),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const body = c.req.valid('json');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
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
            gatewayId: body.gatewayId,
            renditions: body.renditions,
            publisherDeviceId: body.publisherDeviceId,
            upstreamExposureId: body.upstreamExposureId,
            params: body.params
          })
          .returning(exposureColumns);
        // A new exposure is no one's upstream yet, so its chain cannot loop.
        await checkGateway(tx, id, body.gatewayId);
        if (body.upstreamExposureId) await checkRenditions(tx, streamId, exposure!.id);
        return exposure!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .patch(
    '/:streamId/exposures/:exposureId',
    describeRoute({
      operationId: 'organisations.streams.exposures.update',
      ...operationVersion(1),
      summary: 'Update an exposure',
      description:
        'Administrators only. Changes only the fields given; `renditions` and `params` are replaced whole. Refused if its upstream would lead back to it, if it would offer a rendition its upstream does not, or stop offering one an exposure downstream of it or a recorder uses.',
      responses: {
        200: { description: 'The updated exposure' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: exposureInUse,
        412: versionMismatch,
        422: invalidExposureReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ExposurePathParamsSchema),
    validator('json', ExposureChangesSchema),
    async c => {
      const { id, streamId, exposureId } = c.req.valid('param');
      const body = c.req.valid('json');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      if (body.upstreamExposureId === exposureId) throw new ApiFailure('exposure_cycle');
      const row = await session.transaction(async tx => {
        // Write first, so row-level security refuses a principal who may not; then check only what the change could
        // break: the gateway when it changed, the chain when it gained an upstream, and the renditions along it when
        // they or the upstream changed.
        const [exposure] = await tx
          .update(exposures)
          .set({
            gatewayId: body.gatewayId,
            renditions: body.renditions,
            publisherDeviceId: body.publisherDeviceId,
            upstreamExposureId: body.upstreamExposureId,
            params: body.params
          })
          .where(and(eq(exposures.organisationId, id), eq(exposures.streamId, streamId), eq(exposures.id, exposureId)))
          .returning(exposureColumns);
        if (!exposure) throw await unchanged(tx, exposures.id, exposureId);
        if (body.gatewayId !== undefined) await checkGateway(tx, id, exposure.gatewayId);
        if (body.upstreamExposureId) await checkChain(tx, streamId, exposureId);
        if (changesRenditions(body)) await checkRenditions(tx, streamId, exposureId);
        return exposure;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:streamId/exposures/:exposureId',
    describeRoute({
      operationId: 'organisations.streams.exposures.delete',
      ...operationVersion(1),
      summary: 'Remove an exposure',
      description: 'Administrators only. Refused while a recorder uses it, or another exposure as its upstream.',
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
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
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
    '/:streamId/exposures/:exposureId/connections',
    describeRoute({
      operationId: 'organisations.streams.exposures.connect',
      ...operationVersion(1),
      summary: 'Connect to an exposure',
      description:
        "Where to read or publish the exposure at its gateway by one of its protocols, with the short-lived credential that admits the caller there: a MoQ relay, path and token, or a URL (such as a WebRTC WHEP or WHIP endpoint) and a token to present as a bearer token or password. `renditions` lists what the connection carries: the rendition chosen, or with `moq` every rendition the exposure offers, as tracks. Ask again before `expiresAt`, when the gateway stops admitting the caller. Members read, signed in. Devices call with an RFC 9421 HTTP Message Signature by their own identity, as for `reports.submit`: they publish the exposures they are the pinned publisher of, and read those exposures' upstreams.",
      responses: {
        200: { description: 'The connection details' },
        400: invalidRequest,
        401: noCaller,
        403: connectionRefused,
        404: notFound,
        412: versionMismatch,
        422: unsupportedConnection,
        503: gatewayUnavailable
      }
    }),
    requireCaller,
    validator('param', ExposurePathParamsSchema),
    validator(
      'json',
      z.strictObject({
        action: ConnectionActionSchema,
        protocol: ConnectionProtocolSchema,
        rendition: ConnectionRenditionSchema
      })
    ),
    async c => {
      const { id, streamId, exposureId } = c.req.valid('param');
      const ask = c.req.valid('json');
      const reference = { organisationId: id, streamId, exposureId };
      const caller = useCaller();
      const pending =
        caller.kind === 'device' ? await asDevice(reference, ask.action) : await asMember(reference, ask.action);
      const connection = await connect(pending, ask);
      c.header('Cache-Control', 'no-store');
      return c.json(connection, 200);
    }
  )
  .post(
    '/:streamId/recorders',
    describeRoute({
      operationId: 'organisations.streams.recorders.create',
      ...operationVersion(1),
      summary: 'Record a stream',
      description:
        "Administrators only. Recording is always backed by one of the stream's exposures, which supplies its gateway, and records one of the renditions it offers.",
      responses: {
        201: { description: 'The new recorder' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidRecorderReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', StreamParamsSchema),
    validator(
      'json',
      z.strictObject({
        exposureId: z.uuid().describe('The exposure of this stream to record.'),
        rendition: RecordedRenditionSchema.default('default'),
        kind: RecorderKindSchema,
        params: SettingsSchema.default({})
      })
    ),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const body = c.req.valid('json');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(async tx => {
        const [stream] = await tx
          .select({ id: streams.id })
          .from(streams)
          .where(and(eq(streams.organisationId, id), eq(streams.id, streamId)));
        if (!stream) throw new ApiFailure('not_found');
        const [recorder] = await tx
          .insert(recorders)
          .values({
            organisationId: id,
            streamId,
            exposureId: body.exposureId,
            rendition: body.rendition,
            kind: body.kind,
            params: body.params
          })
          .returning(recorderColumns);
        await checkRecorderRendition(tx, streamId, recorder!.id);
        return recorder!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .patch(
    '/:streamId/recorders/:recorderId',
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
        422: invalidRecorderReference,
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
          rendition: RecordedRenditionSchema.optional(),
          kind: RecorderKindSchema.optional(),
          params: SettingsSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, streamId, recorderId } = c.req.valid('param');
      const body = c.req.valid('json');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(async tx => {
        const [recorder] = await tx
          .update(recorders)
          .set({ exposureId: body.exposureId, rendition: body.rendition, kind: body.kind, params: body.params })
          .where(and(eq(recorders.organisationId, id), eq(recorders.streamId, streamId), eq(recorders.id, recorderId)))
          .returning(recorderColumns);
        if (!recorder) throw await unchanged(tx, recorders.id, recorderId);
        if (body.exposureId !== undefined || body.rendition !== undefined)
          await checkRecorderRendition(tx, streamId, recorderId);
        return recorder;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:streamId/recorders/:recorderId',
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
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
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
