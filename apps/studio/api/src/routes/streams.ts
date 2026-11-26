import { createStore } from '@conservationtv/store';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { connectExposure, connectStream } from '../gateways/connect.ts';
import { encoderIngest, publishStream } from '../gateways/publish.ts';
import { liveExposures } from '../gateways/live.ts';
import { ConnectionActionSchema } from '../gateways/provider.ts';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, useUser } from '../middleware/principal.ts';
import {
  deleteStreamKey,
  ensurePersonalStream,
  replaceStreamKey,
  requirePublisher,
  updateStreamAndKey
} from '../services/publishing.ts';
import { audited } from '../audit/audit.ts';
import {
  createExposure,
  createRecorder,
  createStream,
  deleteExposure,
  deleteRecorder,
  deleteStream,
  getStream,
  listExposures,
  listRecorders,
  listStreams,
  updateExposure,
  updateRecorder,
  withoutCode
} from '../services/streams.ts';
import {
  checkOffered,
  RenditionSchema,
  RenditionsSchema,
  withRendition,
  withRenditions,
  withStreamRenditions
} from '../topology/renditions.ts';
import { PERSONAL_DEVICES } from '../topology/personal-devices.ts';
import { ExposureParamsSchema, SettingsSchema } from '../topology/settings.ts';
import { GatewayIdSchema } from './gateways.ts';
import {
  conflict,
  connectionRefused,
  forbidden,
  gatewayUnavailable,
  inUse,
  exposureInUse,
  invalidExposureReference,
  invalidRecorderReference,
  invalidRecorderRendition,
  invalidReference,
  invalidRequest,
  noCaller,
  noIngest,
  notFound,
  notPublisher,
  notPushed,
  operationVersion,
  unauthenticated,
  streamConnectionRefused,
  streamUndeliverable,
  unavailable,
  unsupportedConnection,
  unsupportedConnectionRendition,
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
const StreamCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,4}$/u, 'One to four letters and digits')
  .nullable()
  .describe(
    "A short name for the stream, one to four letters and digits (kept in capitals), unique in the organisation: what chat and a show's controls may call it by. Null for none."
  );
export type StreamCode = z.output<typeof StreamCodeSchema>;
const ReadProtocolsSchema = z
  .array(z.string().trim().min(1).max(60))
  .min(1)
  .max(10)
  .describe('The protocols the caller can play, in its order of preference, such as `moq` or `webrtc`.');
export type ReadProtocols = z.output<typeof ReadProtocolsSchema>;
const ConnectActionSchema = z
  .enum(['read', 'publish'])
  .default('read')
  .describe('Whether to read the stream, or publish it: `read` when left out.');
export type ConnectAction = z.output<typeof ConnectActionSchema>;
const PublisherNetworkSchema = z
  .uuid()
  .nullable()
  .default(null)
  .describe(
    "Publishing only: the organisation's network the publisher is on, such as a phone on a site's wifi, which reaches that network's gateways as well as the internet's; null (the default) for the internet alone. The API cannot tell for a browser or an encoder, so the publisher says. Ignored when reading."
  );
export type PublisherNetwork = z.output<typeof PublisherNetworkSchema>;
const EncoderNetworkSchema = z
  .uuid()
  .nullable()
  .default(null)
  .describe(
    "The organisation's network the encoder publishes from, such as OBS on a site's own network, which reaches that network's gateways as well as the internet's; null (the default) for the internet alone."
  );
export type EncoderNetwork = z.output<typeof EncoderNetworkSchema>;
const PersonalDeviceParamsSchema = OrganisationParamsSchema.extend({
  device: z.enum(PERSONAL_DEVICES).describe('The kind of device you go live from.')
});
export type PersonalDeviceParams = z.output<typeof PersonalDeviceParamsSchema>;
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
const RecordedRenditionSchema = RenditionSchema.describe(
  'The rendition of the exposure to record: `default`, the one every exposure offers. Versions after the first record the largest picture the exposure carries, and take none.'
);
export type RecordedRendition = z.output<typeof RecordedRenditionSchema>;
const ConnectionProtocolSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe('One of the protocols the gateway is read by (to read), or published to (to publish), such as `webrtc`.');
export type ConnectionProtocol = z.output<typeof ConnectionProtocolSchema>;
const ConnectionRenditionSchema = RenditionSchema.optional().describe(
  'The rendition to connect to: `default`, the one every exposure offers, or left out.'
);
export type ConnectionRendition = z.output<typeof ConnectionRenditionSchema>;
const RecorderKindSchema = z.string().trim().min(1).max(60).describe('The recording implementation.');
export type RecorderKind = z.output<typeof RecorderKindSchema>;

// An organisation's streams, with their exposures and recorders, in the principal's request session: members read
// them, administrators manage them. A stream's source device, an exposure's gateway and publisher, and a recorder's
// exposure must belong to the same organisation (and an exposure's upstream and a recorder's exposure to the same
// stream); the database's composite foreign keys refuse anything else. What they cannot check, an exposure's gateway
// (which may be built in) and its upstream chain, each write checks (src/services/streams.ts). The first versions of
// the operations that spoke of renditions answer as if every exposure offered `default` alone (src/topology/renditions.ts).

/** What `organisations.streams.connect` did that its audit entry is kept for: publishing, and making exposures doing so. */
interface PublishOutcome {
  publishing: boolean;
  made: boolean;
}

const [withPublishOutcome, usePublishOutcome] = createStore<PublishOutcome>('publishOutcome');

const auditedConfiguration = audited('configuration');

/**
 * `audited('configuration')` for `organisations.streams.connect` when it publishes, and then only for the change it
 * made (a pushed stream's exposures) or a refusal: a read, or a publish to a chain that stands, changes nothing.
 */
const auditedPublish = createMiddleware(async (c, next) => {
  const outcome: PublishOutcome = { publishing: false, made: false };
  await withPublishOutcome(outcome, next);
  const kept = outcome.made || (outcome.publishing && !c.res.ok);
  if (kept) await auditedConfiguration(c, async () => {});
});

const CONNECT_DESCRIPTION =
  "Where to read or publish the exposure at its gateway by one of its protocols, with the short-lived credential that admits the caller there: a MoQ relay, path and token, or a URL (such as a WebRTC WHEP or WHIP endpoint) and a token to present as a bearer token, or as the URL's `jwt` query parameter where the protocol has no headers (RTSP, RTMP). A connection by URL carries the one picture the exposure's source gives; a MoQ broadcast's catalog lists it, and any smaller pictures beside it, each by its size, for a reader to pick from by the size it needs. Ask again before `expiresAt`, when the gateway stops admitting the caller. Members read, signed in. Devices call with an RFC 9421 HTTP Message Signature by their own identity, as for `reports.submit`: they publish the exposures they are the pinned publisher of, and read those exposures' upstreams; an output's agent reads any exposure of a stream its output may play that it reaches: on the internet, or on its own network, and on its output's input gateway when that names one (see `organisations.streams.connect`, which chooses the exposure for the reader).";

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.streams.list',
      ...operationVersion(1),
      summary: "List an organisation's streams",
      description:
        'Each with its exposures and recorders, as `organisations.streams.get` reads one. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The streams, oldest first, each with its exposures and recorders, oldest first' },
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
      const rows = await transaction(() => listStreams(id));
      const streams = rows.map(row => withStreamRenditions(withoutCode(row)));
      c.header('Cache-Control', 'no-store');
      return c.json({ streams }, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.streams.list',
      ...operationVersion(2),
      summary: "List an organisation's streams",
      description:
        'Each with its short `code`, its exposures and its recorders, as `organisations.streams.get` reads one. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The streams, oldest first, each with its exposures and recorders, oldest first' },
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
      const rows = await transaction(() => listStreams(id));
      c.header('Cache-Control', 'no-store');
      return c.json({ streams: rows }, 200);
    }
  )
  // Before `/:streamId`, which would otherwise take `live` for a stream's ID.
  .get(
    '/live',
    describeRoute({
      operationId: 'organisations.streams.live.list',
      ...operationVersion(1),
      summary: "List which of an organisation's exposures are live",
      description:
        'Each of its exposures, oldest first, with its `streamId` and `gatewayId`, and whether it is `live` now, as its gateway says: for conservation.tv, whether the relay has announced the broadcast its readers watch; for a MediaMTX gateway, whether one of its paths was ready when the agent running the gateway last reported, within the last 45 seconds. `live` is null when the gateway cannot say: a gateway that cannot be asked, fails to answer, or has no recent report. `checkedAt` is when the gateway said so, null when it did not: answers are kept for up to 5 seconds. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The exposures, oldest first, each with whether it is live' },
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
      const rows = await liveExposures(id);
      c.header('Cache-Control', 'no-store');
      return c.json({ exposures: rows }, 200);
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
    audited('configuration'),
    validator('param', OrganisationParamsSchema),
    validator('json', z.strictObject({ name: StreamNameSchema, sourceDeviceId: SourceDeviceSchema.default(null) })),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createStream(id, body));
      c.header('Cache-Control', 'no-store');
      return c.json(withoutCode(row), 201);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.streams.create',
      ...operationVersion(2),
      summary: 'Create a stream',
      description: 'Administrators only. Refused (`conflict`) for a `code` another of its streams has.',
      responses: {
        201: { description: 'The new stream' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        409: conflict,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z.strictObject({
        name: StreamNameSchema,
        code: StreamCodeSchema.default(null),
        sourceDeviceId: SourceDeviceSchema.default(null)
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createStream(id, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  // Before `/:streamId`'s routes, which would otherwise take `personal` for a stream's ID.
  .put(
    '/personal/:device',
    describeRoute({
      operationId: 'organisations.streams.personal.ensure',
      ...operationVersion(1),
      summary: 'Get or create the stream you go live on',
      description:
        'Members with the right to publish (`streamPublisher`, which administrators hold). The stream you go live on from this kind of device, `phone` or `computer`: the one you went live on before, or a new one with no source device, named for you ("Ada\'s phone"), made now. Publish it with `organisations.streams.connect` (`action: publish`). It is the organisation\'s stream like any other, and stays when you leave.',
      responses: {
        200: { description: 'The stream' },
        400: invalidRequest,
        401: unauthenticated,
        403: notPublisher,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', PersonalDeviceParamsSchema),
    async c => {
      const { id, device } = c.req.valid('param');
      const member = useUser();
      const row = await trustedTransaction(
        async () => {
          await requirePublisher(id, member.id);
          return ensurePersonalStream(id, member.id, device);
        },
        { name: 'streams.personal' }
      );
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
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
      const row = await transaction(async () => {
        const stream = await getStream(id, streamId);
        if (!stream) return undefined;
        const streamExposures = await listExposures(id, streamId);
        const streamRecorders = await listRecorders(id, streamId);
        return { ...stream, exposures: streamExposures, recorders: streamRecorders };
      });
      if (!row) throw new ApiFailure('not_found');
      const stream = withStreamRenditions(withoutCode(row));
      c.header('Cache-Control', 'no-store');
      return c.json(stream, 200);
    }
  )
  .get(
    '/:streamId',
    describeRoute({
      operationId: 'organisations.streams.get',
      ...operationVersion(2),
      summary: 'Read a stream',
      description: 'With its short `code`, its exposures and its recorders.',
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
      const row = await transaction(async () => {
        const stream = await getStream(id, streamId);
        if (!stream) return undefined;
        const streamExposures = await listExposures(id, streamId);
        const streamRecorders = await listRecorders(id, streamId);
        return { ...stream, exposures: streamExposures, recorders: streamRecorders };
      });
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
        "Administrators only: rename it, or change its source device. The stream's identity stays the same when its camera changes. A stream given a source device loses its encoders' key, if it had one.",
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
    audited('configuration'),
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
      const row = await transaction(() => updateStreamAndKey(id, streamId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(withoutCode(row), 200);
    }
  )
  .patch(
    '/:streamId',
    describeRoute({
      operationId: 'organisations.streams.update',
      ...operationVersion(2),
      summary: 'Update a stream',
      description:
        "Administrators only: rename it, change its short `code` (refused as `conflict` when another of its streams has it), or change its source device. The stream's identity stays the same when its camera changes. A stream given a source device loses its encoders' key, if it had one.",
      responses: {
        200: { description: 'The updated stream, without its exposures and recorders' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: conflict,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', StreamParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          name: StreamNameSchema.optional(),
          code: StreamCodeSchema.optional(),
          sourceDeviceId: SourceDeviceSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateStreamAndKey(id, streamId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .post(
    '/:streamId/connections',
    describeRoute({
      operationId: 'organisations.streams.connect',
      ...operationVersion(1),
      summary: 'Read or publish a stream',
      description:
        "Read a stream by whatever delivers it, or publish one that has no source of its own, given the protocols the caller can play or send, in its order of preference: the exposure to read or publish (`exposureId`, at `gatewayId`) and its `connection`, as `organisations.streams.exposures.connect` gives one. Ask again before `connection.expiresAt`: the answer may name another exposure.\n\nReading: the candidates are the stream's exposures on gateways the caller reaches, read by a protocol it named: a gateway on no network is on the internet, reached by everyone, and one on a network is reached by a device on that network alone, so a member's browser reaches internet gateways only. An output's agent reads only from its output's input gateway, when it names one. Of those, one on the caller's own network is preferred, then conservation.tv, then any other internet gateway; exposures whose health is failing come last, and for a stream with no source, after them any its gateway says is not live. Members read, signed in. Devices call with an RFC 9421 HTTP Message Signature by their own identity: an output's agent reads what the show its output follows places, or under `external` control any of its organisation's streams.\n\nPublishing (`action: publish`): only a stream with no source device (`not_pushed` otherwise). The gateway is chosen as a reader's is, from those the publisher reaches (the internet, and the network it names as `networkId`) published to by a protocol it named, and the stream's exposure there is made if it has none, with one at conservation.tv that the gateway's agent republishes it to when it is elsewhere; both are kept for the next time. Members with the right to publish (`streamPublisher`, which administrators hold), signed in, or their browser's own device (`organisations.browser.ensure`) signing for them; a member's own stream (`organisations.streams.personal.ensure`) is published by that member alone (`forbidden` for anyone else). A new exposure at a MediaMTX gateway is served once its agent next asks for its configuration, within about half a minute: until then publishing there is refused, so try again.",
      responses: {
        200: { description: 'The exposure chosen, and how to connect to it' },
        400: invalidRequest,
        401: noCaller,
        403: streamConnectionRefused,
        404: notFound,
        409: notPushed,
        412: versionMismatch,
        422: streamUndeliverable,
        503: gatewayUnavailable
      }
    }),
    requirePrincipal,
    auditedPublish,
    validator('param', StreamParamsSchema),
    validator(
      'json',
      z.strictObject({
        protocols: ReadProtocolsSchema,
        action: ConnectActionSchema,
        networkId: PublisherNetworkSchema
      })
    ),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const { action, protocols, networkId } = c.req.valid('json');
      const location = { organisationId: id, streamId };
      c.header('Cache-Control', 'no-store');
      if (action === 'read') {
        const connection = await connectStream(location, { protocols });
        return c.json(connection, 200);
      }
      const outcome = usePublishOutcome();
      outcome.publishing = true;
      const { made, ...published } = await publishStream(location, { protocols, networkId });
      outcome.made = made;
      return c.json(published, 200);
    }
  )
  .put(
    '/:streamId/encoder',
    describeRoute({
      operationId: 'organisations.streams.encoder.ensure',
      ...operationVersion(1),
      summary: 'Get where an encoder publishes a stream',
      description:
        "Members with the right to publish (`streamPublisher`, which administrators hold), for a stream with no source device (`not_pushed` otherwise); a member's own stream (`organisations.streams.personal.ensure`) only for that member (`forbidden` for anyone else). What to paste into an encoder that only takes a URL, such as OBS or a phone's streaming app: for each protocol the chosen gateway's servers are known for (`rtmps`, `rtmp`, `webrtc` for WHIP), the whole `url`, and the `server` and `streamKey` an encoder that asks for them apart takes (RTMP), or the `bearerToken` (WHIP). They carry the stream's `key`, made now if it has none, which lasts until it is replaced. The gateway is a MediaMTX one, chosen as `organisations.streams.connect` chooses one to publish to, from those on the network named as `networkId` (an encoder on site) and the internet's (null, the default), and the stream's exposure there is made if it has none, with one at conservation.tv its agent republishes to; so the URL keeps working. A new one is served once the gateway's agent next asks for its configuration, within about half a minute.",
      responses: {
        200: { description: 'Where an encoder publishes, and the key' },
        400: invalidRequest,
        401: unauthenticated,
        403: notPublisher,
        404: notFound,
        409: notPushed,
        412: versionMismatch,
        422: noIngest,
        503: gatewayUnavailable
      }
    }),
    requirePrincipal,
    audited('secrets'),
    validator('param', StreamParamsSchema),
    validator('json', z.strictObject({ networkId: EncoderNetworkSchema })),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const { networkId } = c.req.valid('json');
      const ingest = await encoderIngest({ organisationId: id, streamId }, networkId);
      c.header('Cache-Control', 'no-store');
      return c.json(ingest, 200);
    }
  )
  .post(
    '/:streamId/key',
    describeRoute({
      operationId: 'organisations.streams.key.replace',
      ...operationVersion(1),
      summary: "Replace a stream's key",
      description:
        "Members with the right to publish (`streamPublisher`, which administrators hold), for a stream with no source device (`not_pushed` otherwise); a member's own stream (`organisations.streams.personal.ensure`) only for that member (`forbidden` for anyone else). A new key for encoders to publish the stream with, in place of any it had: an encoder with the old one is refused once the gateway's agent next asks for its configuration, within about half a minute, and one already publishing carries on until it reconnects. `organisations.streams.encoder.ensure` gives it with where to paste it.",
      responses: {
        200: { description: 'The new key' },
        400: invalidRequest,
        401: unauthenticated,
        403: notPublisher,
        404: notFound,
        409: notPushed,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('secrets'),
    validator('param', StreamParamsSchema),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const member = useUser();
      const row = await transaction(() => replaceStreamKey(id, streamId, member.id));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:streamId/key',
    describeRoute({
      operationId: 'organisations.streams.key.delete',
      ...operationVersion(1),
      summary: "Remove a stream's key",
      description:
        "Members with the right to publish (`streamPublisher`, which administrators hold); a member's own stream (`organisations.streams.personal.ensure`) only for that member or an administrator (`forbidden` for anyone else). No encoder publishes the stream by a key from the gateway's agent's next configuration on, until `organisations.streams.encoder.ensure` makes another. `not_found` for a stream with none.",
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
    audited('secrets'),
    validator('param', StreamParamsSchema),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const member = useUser();
      await transaction(() => deleteStreamKey(id, streamId, member.id));
      return c.body(null, 204);
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
    audited('configuration'),
    validator('param', StreamParamsSchema),
    async c => {
      const { id, streamId } = c.req.valid('param');
      await transaction(() => deleteStream(id, streamId));
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
        'Administrators only. Declares how the stream is delivered: to which gateway, and by which publisher from which upstream. The gateway decides the protocols it is read by. `renditions` is accepted and ignored: every exposure offers `default`, the picture its source gives, as the answer says.',
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
    audited('configuration'),
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
      const { renditions: _renditions, ...body } = c.req.valid('json');
      const row = await transaction(async () => {
        const stream = await getStream(id, streamId);
        if (!stream) throw new ApiFailure('not_found');
        return createExposure(id, streamId, body);
      });
      c.header('Cache-Control', 'no-store');
      return c.json(withRenditions(row), 201);
    }
  )
  .post(
    '/:streamId/exposures',
    describeRoute({
      operationId: 'organisations.streams.exposures.create',
      ...operationVersion(2),
      summary: 'Expose a stream',
      description:
        'Administrators only. Declares how the stream is delivered: to which gateway, and by which publisher from which upstream. The gateway decides the protocols it is read by. It carries the picture its source gives, and smaller ones where its protocol can and its source can make them, which the system decides.',
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
    audited('configuration'),
    validator('param', StreamParamsSchema),
    validator(
      'json',
      z.strictObject({
        gatewayId: GatewaySchema,
        publisherDeviceId: PublisherDeviceSchema.default(null),
        upstreamExposureId: UpstreamExposureSchema.default(null),
        params: ExposureParamsSchema.default({})
      })
    ),
    async c => {
      const { id, streamId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(async () => {
        const stream = await getStream(id, streamId);
        if (!stream) throw new ApiFailure('not_found');
        return createExposure(id, streamId, body);
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
        'Administrators only. Changes only the fields given; `params` is replaced whole. Refused if its upstream would lead back to it. `renditions` is accepted and ignored: every exposure offers `default`, as the answer says.',
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
    audited('configuration'),
    validator('param', ExposurePathParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          gatewayId: GatewaySchema.optional(),
          renditions: RenditionsSchema.optional(),
          publisherDeviceId: PublisherDeviceSchema.optional(),
          upstreamExposureId: UpstreamExposureSchema.optional(),
          params: ExposureParamsSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, streamId, exposureId } = c.req.valid('param');
      const { renditions: _renditions, ...body } = c.req.valid('json');
      const row = await transaction(() => updateExposure(id, streamId, exposureId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(withRenditions(row), 200);
    }
  )
  .patch(
    '/:streamId/exposures/:exposureId',
    describeRoute({
      operationId: 'organisations.streams.exposures.update',
      ...operationVersion(2),
      summary: 'Update an exposure',
      description:
        'Administrators only. Changes only the fields given; `params` is replaced whole. Refused if its upstream would lead back to it.',
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
    audited('configuration'),
    validator('param', ExposurePathParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          gatewayId: GatewaySchema.optional(),
          publisherDeviceId: PublisherDeviceSchema.optional(),
          upstreamExposureId: UpstreamExposureSchema.optional(),
          params: ExposureParamsSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, streamId, exposureId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateExposure(id, streamId, exposureId, body));
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
    audited('configuration'),
    validator('param', ExposurePathParamsSchema),
    async c => {
      const { id, streamId, exposureId } = c.req.valid('param');
      await transaction(() => deleteExposure(id, streamId, exposureId));
      return c.body(null, 204);
    }
  )
  .post(
    '/:streamId/exposures/:exposureId/connections',
    describeRoute({
      operationId: 'organisations.streams.exposures.connect',
      ...operationVersion(1),
      summary: 'Connect to an exposure',
      description: `${CONNECT_DESCRIPTION} \`rendition\` may only be \`default\`, the one every exposure offers, and \`renditions\`, what the connection carries, says so.`,
      responses: {
        200: { description: 'The connection details' },
        400: invalidRequest,
        401: noCaller,
        403: connectionRefused,
        404: notFound,
        412: versionMismatch,
        422: unsupportedConnectionRendition,
        503: gatewayUnavailable
      }
    }),
    requirePrincipal,
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
      const { rendition, ...ask } = c.req.valid('json');
      const connection = await connectExposure({ organisationId: id, streamId, exposureId }, ask);
      // After whatever refuses the connection otherwise, as when the exposure listed what it offered.
      checkOffered(rendition);
      c.header('Cache-Control', 'no-store');
      return c.json(withRenditions(connection), 200);
    }
  )
  .post(
    '/:streamId/exposures/:exposureId/connections',
    describeRoute({
      operationId: 'organisations.streams.exposures.connect',
      ...operationVersion(2),
      summary: 'Connect to an exposure',
      description: CONNECT_DESCRIPTION,
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
    requirePrincipal,
    validator('param', ExposurePathParamsSchema),
    validator('json', z.strictObject({ action: ConnectionActionSchema, protocol: ConnectionProtocolSchema })),
    async c => {
      const { id, streamId, exposureId } = c.req.valid('param');
      const ask = c.req.valid('json');
      const connection = await connectExposure({ organisationId: id, streamId, exposureId }, ask);
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
        "Administrators only. Recording is always backed by one of the stream's exposures, which supplies its gateway, and records its `default` rendition, the one every exposure offers.",
      responses: {
        201: { description: 'The new recorder' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidRecorderRendition,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
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
      const { rendition, ...body } = c.req.valid('json');
      const row = await transaction(async () => {
        const stream = await getStream(id, streamId);
        if (!stream) throw new ApiFailure('not_found');
        const recorder = await createRecorder(id, streamId, body);
        // After the write, as when the exposure listed what it offered: refused, it is undone.
        checkOffered(rendition);
        return recorder;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(withRendition(row), 201);
    }
  )
  .post(
    '/:streamId/recorders',
    describeRoute({
      operationId: 'organisations.streams.recorders.create',
      ...operationVersion(2),
      summary: 'Record a stream',
      description:
        "Administrators only. Recording is always backed by one of the stream's exposures, which supplies its gateway, and records the largest picture it carries.",
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
    audited('configuration'),
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
      const row = await transaction(async () => {
        const stream = await getStream(id, streamId);
        if (!stream) throw new ApiFailure('not_found');
        return createRecorder(id, streamId, body);
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
      description:
        'Administrators only. Changes only the fields given; `params` is replaced whole. `rendition` may only be `default`, the one every exposure offers.',
      responses: {
        200: { description: 'The updated recorder' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidRecorderRendition,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
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
      const { rendition, ...body } = c.req.valid('json');
      const row = await transaction(async () => {
        const recorder = await updateRecorder(id, streamId, recorderId, body);
        // After the write, as when the exposure listed what it offered: refused, it is undone.
        checkOffered(rendition);
        return recorder;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(withRendition(row), 200);
    }
  )
  .patch(
    '/:streamId/recorders/:recorderId',
    describeRoute({
      operationId: 'organisations.streams.recorders.update',
      ...operationVersion(2),
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
    audited('configuration'),
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
      const row = await transaction(() => updateRecorder(id, streamId, recorderId, body));
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
    audited('configuration'),
    validator('param', RecorderParamsSchema),
    async c => {
      const { id, streamId, recorderId } = c.req.valid('param');
      await transaction(() => deleteRecorder(id, streamId, recorderId));
      return c.body(null, 204);
    }
  );
