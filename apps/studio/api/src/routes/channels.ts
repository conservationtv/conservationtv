import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import {
  freshTwitchCredentials,
  TWITCH_INGEST,
  twitchAuthorizeUrl,
  twitchStreamKey,
  twitchStreamStats
} from '../channels/twitch.ts';
import { transaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal, useUser } from '../middleware/principal.ts';
import {
  createRtmpChannel,
  deleteChannel,
  getChannel,
  listChannels,
  getChannelCredentials,
  saveChannelCredentials,
  updateChannel
} from '../services/channels.ts';
import { getOrganisation } from '../services/organisations.ts';
import {
  channelUnavailable,
  forbidden,
  invalidRequest,
  invalidSignature,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  unsupportedChannelStats,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const ChannelParamsSchema = OrganisationParamsSchema.extend({ channelId: z.uuid().describe('The channel.') });
export type ChannelParams = z.output<typeof ChannelParamsSchema>;

const ChannelNameSchema = z.string().trim().min(1).max(120).describe('What the channel is called in the studio.');
export type ChannelName = z.output<typeof ChannelNameSchema>;
const RtmpUrlSchema = z
  .url({ protocol: /^rtmps?$/u })
  .describe(
    'The RTMP(S) server URL, with its application, such as `rtmps://ingest.global-contribute.live-video.net/app`.'
  );
export type RtmpUrl = z.output<typeof RtmpUrlSchema>;
const StreamKeySchema = z.string().trim().min(1).max(512).describe('The stream key the server gave.');
export type StreamKey = z.output<typeof StreamKeySchema>;

/** How long a Twitch connection may take between leaving the studio and coming back to the callback. */
export const CONNECT_STATE_SECONDS = 600;

/** The cache key a Twitch connection's state is kept under until its callback. */
export const connectStateKey = (state: string) => `channel-connect:twitch:${state}`;

/** What a Twitch connection's state remembers: who started it, for which organisation. */
export const ConnectStateSchema = z.object({ organisationId: z.uuid(), userId: z.string() });
export type ConnectState = z.output<typeof ConnectStateSchema>;

// Where an organisation's shows go out to (src/services/channels.ts): members list them, administrators add, rename
// and remove them; each show forwards to the channels it has an enabled forward to (src/routes/shows.ts). An RTMP
// destination is entered by hand; a Twitch channel is connected by OAuth, starting here (`twitch.authorize`) and
// finishing at /channels/twitch/callback (src/routes/channel-callbacks.ts). A show's output agent asks for the ingest of
// each channel it forwards to, signed as its device, when it forwards the programme, and for what a Twitch channel's
// platform says of it (`stats.get`) whenever it reports on the channel: the API reads Twitch itself, so the
// connection's tokens never leave it.

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.channels.list',
      ...operationVersion(1),
      summary: "List where an organisation's broadcast goes out to",
      description:
        'Its channels, oldest first, without their credentials. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The channels' },
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
      const rows = await transaction(() => listChannels(id));
      c.header('Cache-Control', 'no-store');
      return c.json({ channels: rows }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.channels.create',
      ...operationVersion(1),
      summary: 'Add an RTMP destination',
      description:
        'Administrators only. Any service that takes RTMP(S), by its server URL and stream key; the key is kept encrypted and never shown again. Twitch channels are connected with `organisations.channels.twitch.authorize` instead.',
      responses: {
        201: { description: 'The new channel' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('json', z.strictObject({ name: ChannelNameSchema, url: RtmpUrlSchema, key: StreamKeySchema })),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createRtmpChannel(id, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .post(
    '/twitch/authorize',
    describeRoute({
      operationId: 'organisations.channels.twitch.authorize',
      ...operationVersion(1),
      summary: 'Start connecting a Twitch channel',
      description:
        "Where to send the browser to approve on Twitch; Twitch sends it back to this API, which connects the channel (or refreshes it, if it is connected already) and returns to the studio's channels page. Valid for 10 minutes; only administrators' connections are kept.",
      responses: {
        200: { description: 'Where to send the browser' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const user = useUser();
      const organisation = await transaction(() => getOrganisation(id));
      if (!organisation) throw new ApiFailure('not_found');
      const state = randomBytes(24).toString('base64url');
      const url = twitchAuthorizeUrl(state);
      const remembered: ConnectState = { organisationId: id, userId: user.id };
      const environment = useEnvironment();
      await environment.cache.put(connectStateKey(state), JSON.stringify(remembered), CONNECT_STATE_SECONDS);
      c.header('Cache-Control', 'no-store');
      return c.json({ url }, 200);
    }
  )
  .get(
    '/:channelId',
    describeRoute({
      operationId: 'organisations.channels.get',
      ...operationVersion(1),
      summary: 'Read a channel',
      description: 'Without its credentials, which the studio never shows. `not_found` unless you are a member.',
      responses: {
        200: { description: 'The channel' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ChannelParamsSchema),
    async c => {
      const { id, channelId } = c.req.valid('param');
      const row = await transaction(() => getChannel(id, channelId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:channelId',
    describeRoute({
      operationId: 'organisations.channels.update',
      ...operationVersion(1),
      summary: 'Rename a channel',
      description: 'Administrators only. Which shows go out to it is theirs: `organisations.shows.forwards.*`.',
      responses: {
        200: { description: 'The channel' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ChannelParamsSchema),
    validator('json', z.strictObject({ name: ChannelNameSchema })),
    async c => {
      const { id, channelId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateChannel(id, channelId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:channelId',
    describeRoute({
      operationId: 'organisations.channels.delete',
      ...operationVersion(1),
      summary: 'Remove a channel',
      description:
        'Administrators only. Its credentials go with it; Twitch keeps the authorization until revoked there.',
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
    validator('param', ChannelParamsSchema),
    async c => {
      const { id, channelId } = c.req.valid('param');
      await transaction(() => deleteChannel(id, channelId));
      return c.body(null, 204);
    }
  )
  .post(
    '/:channelId/ingest',
    describeRoute({
      operationId: 'organisations.channels.ingest',
      ...operationVersion(1),
      summary: 'Read where to send the broadcast for a channel',
      description:
        "Devices holding `channelBroadcaster` at the organisation only, which the show's output is granted while it is the output, signed as the device (an RFC 9421 HTTP Message Signature, as for `deviceConfiguration.get`): the RTMP(S) server URL and stream key to forward the program to. For Twitch, read from Twitch now, refreshing the connection's tokens as needed.",
      responses: {
        200: { description: 'The ingest' },
        400: invalidRequest,
        401: invalidSignature,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: channelUnavailable
      }
    }),
    requirePrincipal,
    validator('param', ChannelParamsSchema),
    async c => {
      const { id, channelId } = c.req.valid('param');
      // Only a device asks for an ingest: administrators can read credentials too, but the studio never shows them.
      const principal = usePrincipal();
      if (principal.kind !== 'device') throw new ApiFailure('forbidden');
      // Row-level security: only a `channelBroadcaster` of the organisation reads the channel's credentials.
      const channel = await transaction(() => getChannelCredentials(id, channelId));
      if (!channel) throw new ApiFailure('not_found');
      const { credentials } = channel;
      if (credentials.kind === 'rtmp') {
        c.header('Cache-Control', 'no-store');
        return c.json({ url: credentials.url, key: credentials.key }, 200);
      }
      // Twitch is called outside the transaction, which isn't held open on the network.
      const fresh = await freshTwitchCredentials(credentials);
      if (fresh !== credentials) await transaction(() => saveChannelCredentials(id, channelId, fresh));
      const key = await twitchStreamKey(fresh, channel.externalId ?? '');
      const ingest = { url: TWITCH_INGEST, key };
      c.header('Cache-Control', 'no-store');
      return c.json(ingest, 200);
    }
  )
  .get(
    '/:channelId/stats',
    describeRoute({
      operationId: 'organisations.channels.stats.get',
      ...operationVersion(1),
      summary: "Read what a channel's platform says of it now",
      description:
        "Devices holding `channelBroadcaster` at the organisation only, which the show's output is granted while it is the output, signed as the device (an RFC 9421 HTTP Message Signature, as for `deviceConfiguration.get`): whether the channel is `live` and, while it is, its `viewers`, when it went live (`startedAt`), its `title`, `category` and `language`, read from Twitch now, refreshing the connection's tokens as needed. `observedAt` is when it was read. The output reports these about `channel:<channelId>`. Only Twitch channels say anything: `unsupported_channel` for an RTMP destination.",
      responses: {
        200: { description: 'What the platform says' },
        400: invalidRequest,
        401: invalidSignature,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: unsupportedChannelStats,
        503: channelUnavailable
      }
    }),
    requirePrincipal,
    validator('param', ChannelParamsSchema),
    async c => {
      const { id, channelId } = c.req.valid('param');
      // Only a device asks, as for an ingest: the studio reads what the output reported instead.
      const principal = usePrincipal();
      if (principal.kind !== 'device') throw new ApiFailure('forbidden');
      // Row-level security: only a `channelBroadcaster` of the organisation reads the channel's credentials.
      const channel = await transaction(() => getChannelCredentials(id, channelId));
      if (!channel) throw new ApiFailure('not_found');
      const { credentials } = channel;
      if (credentials.kind !== 'twitch') throw new ApiFailure('unsupported_channel');
      // Twitch is called outside the transaction, which isn't held open on the network.
      const fresh = await freshTwitchCredentials(credentials);
      if (fresh !== credentials) await transaction(() => saveChannelCredentials(id, channelId, fresh));
      const stats = await twitchStreamStats(fresh, channel.externalId ?? '');
      const environment = useEnvironment();
      const observedAt = new Date(environment.clock()).toISOString();
      c.header('Cache-Control', 'no-store');
      return c.json({ ...stats, observedAt }, 200);
    }
  );
