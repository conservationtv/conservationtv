import { MAX_SLOTS } from '@conservationtv/shows';
import { MAX_SYNC_OFFSET_MS, MIN_SYNC_OFFSET_MS } from '@strangecyan/vignette';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { useDevice } from '../middleware/device.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { audited } from '../audit/audit.ts';
import { selectDeviceOutput } from '../services/outputs.ts';
import {
  createShow,
  deleteShow,
  getShow,
  getShowLineup,
  listShows,
  renameShow,
  showVisible,
  swapLineup,
  updateShowControls,
  updateShowStream,
  withoutControls
} from '../services/shows.ts';
import {
  conflict,
  forbidden,
  invalidReference,
  invalidRequest,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch,
  webSocket
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const ShowParamsSchema = OrganisationParamsSchema.extend({ showId: z.uuid().describe('The show.') });
export type ShowParams = z.output<typeof ShowParamsSchema>;
const ShowNameSchema = z.string().trim().min(1).max(120).describe('What the show is called in the studio.');
export type ShowName = z.output<typeof ShowNameSchema>;
const ShowStreamParamsSchema = ShowParamsSchema.extend({ streamId: z.uuid().describe('The stream.') });
export type ShowStreamParams = z.output<typeof ShowStreamParamsSchema>;
const SlotsSchema = z
  .int()
  .min(0)
  .max(MAX_SLOTS)
  .describe('How many slots its layout has, from none to six; the lineup fills them in order.');
export type Slots = z.output<typeof SlotsSchema>;
const VolumeSchema = z.number().min(-60).max(12).describe('A level, in decibels: 0 is standard volume.');
export type Volume = z.output<typeof VolumeSchema>;
const MutedSchema = z.boolean().describe('Whether it is muted.');
export type Muted = z.output<typeof MutedSchema>;
const TakeoverStreamSchema = z
  .uuid()
  .nullable()
  .describe(
    "The stream armed to take over the screen, any of the organisation's: placed off air, so it is already playing when it goes live. Arming another, or null to disarm, ends a live takeover unless `takeoverLive` is given too."
  );
export type TakeoverStream = z.output<typeof TakeoverStreamSchema>;
const TakeoverLiveSchema = z
  .boolean()
  .describe('Whether the armed stream has taken over the screen. Only while one is armed.');
export type TakeoverLive = z.output<typeof TakeoverLiveSchema>;
const StreamReferenceSchema = z
  .union([
    z.strictObject({ streamId: z.uuid().describe('A stream in the lineup.') }),
    z.strictObject({ position: z.int().min(1).describe('A position in the lineup, from 1.') })
  ])
  .describe('A stream in the lineup, by its ID or its position.');
export type StreamReference = z.output<typeof StreamReferenceSchema>;
const SyncOffsetSchema = z
  .int()
  .min(MIN_SYNC_OFFSET_MS)
  .max(MAX_SYNC_OFFSET_MS)
  .describe(
    'How far its sound is shifted against its picture, in milliseconds: later when positive, and when negative its picture is held back instead, by at most 950.'
  );
export type SyncOffset = z.output<typeof SyncOffsetSchema>;
const AudioStreamSchema = z
  .uuid()
  .nullable()
  .describe("The stream whose sound it brings, one of the organisation's: null for its own.");
export type AudioStream = z.output<typeof AudioStreamSchema>;

// An organisation's shows (src/services/shows.ts, docs/shows.md): what is on screen, each composed by an object of
// its own (src/shows/host.tsx, keyed by the show's ID) from what is in the database. Members read and operate them:
// the layout, the lineup's order, the mix and the takeover. Administrators create, name and delete them. How a show
// goes out is each output's that follows it (src/routes/outputs.ts). Each command on a show is audited as a
// configuration change, which pokes that show's object once it has committed (src/audit/audit.ts,
// src/shows/pokes.ts), so it looks again; any other change to what it is composed from reaches it from where that
// change is made.
//
// A show is followed as a vignette stream over a WebSocket, by members signed in by their session cookie and by the
// agents of the outputs following it, signed as their devices. The first follow since the show's object started syncs
// it first. Following is a versionless operation: it is a WebSocket, which the SDK gives the address of (`webSocket`).
// A frame page (packages/shows' `*.frame.tsx`, as OBS or an iframe opens it) follows its own source over a WebSocket
// too, with no session at all, so that socket serves frame sources only (src/shows/host.tsx). The show's bundle names
// that address (src/shows/broadcast.ts), so it is no operation: its route is hidden.
// The show's object does not run under row-level security, so the routes that reach it for a member first read the
// show as the caller: members of other organisations get `not_found`.
// Cross-site requests are left to Better Auth's session cookie, which is `SameSite=Lax`: no other site's page can send
// it with a WebSocket handshake or a POST. Same-site pages can, and a WebSocket has no CORS to keep them from reading
// it, so this relies on every host under conservation.tv being ours, gateways' included.

/** Refuse any device but those of the outputs following the show (`not_found`), as trusted code. */
async function requireFollower(organisationId: string, showId: string) {
  const device = useDevice();
  const output = await trustedTransaction(() => selectDeviceOutput(device.id));
  if (output?.organisationId !== organisationId || output.showId !== showId) throw new ApiFailure('not_found');
}

/** Refuse a show the caller cannot see (`not_found`). */
async function requireShow(organisationId: string, showId: string) {
  const visible = await transaction(() => showVisible(organisationId, showId));
  if (!visible) throw new ApiFailure('not_found');
}

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.shows.list',
      ...operationVersion(1),
      summary: "List an organisation's shows",
      description:
        'Each with the outputs following it, as `organisations.shows.get` reads one. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The shows, oldest first' },
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
      const rows = await transaction(() => listShows(id));
      // As they were before shows had controls.
      const shows = rows.map(withoutControls);
      c.header('Cache-Control', 'no-store');
      return c.json({ shows }, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.shows.list',
      ...operationVersion(2),
      summary: "List an organisation's shows",
      description:
        'Each with how it is operated (its layout, its mix and its takeover) and the outputs following it, as `organisations.shows.get` reads one, without its lineup. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The shows, oldest first' },
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
      const rows = await transaction(() => listShows(id));
      c.header('Cache-Control', 'no-store');
      return c.json({ shows: rows }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.shows.create',
      ...operationVersion(1),
      summary: 'Create a show',
      description:
        'Administrators only. It is on screen once it is composed, and goes out through each output that follows it (`organisations.outputs.update`).',
      responses: {
        201: { description: 'The new show' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', OrganisationParamsSchema),
    validator('json', z.strictObject({ name: ShowNameSchema })),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createShow(id, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:showId',
    describeRoute({
      operationId: 'organisations.shows.get',
      ...operationVersion(1),
      summary: 'Read a show',
      description: 'With the outputs following it.',
      responses: {
        200: { description: 'The show' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      const row = await transaction(() => getShow(id, showId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(withoutControls(row), 200);
    }
  )
  .get(
    '/:showId',
    describeRoute({
      operationId: 'organisations.shows.get',
      ...operationVersion(2),
      summary: 'Read a show',
      description:
        'How it is operated (`slots`, its layout; `volumeDb` and `muted`, its own mix; `takeoverStreamId`, the stream armed to take over, and `takeoverLive`, whether it has), the outputs following it, and its `lineup`: the camera streams of the organisation, and its pushed streams (going live from a phone, a PC or OBS) while someone publishes them, as the health of their deliveries says. Those in the lineup come first, in position order (the first `slots` are on screen), then those out of it, each with why (`absence`: a pushed stream waiting to be swapped in, `standby`; a camera that is `locked` or `disabled`; or nothing delivering it, `undelivered`), and each with how the show mixes its sound. A camera that is unlocked, or new, joins the lineup at the end; a pushed stream is never placed by itself, and leaves the lineup once nobody publishes it. `takeoverMix` is how the show mixes the stream armed to take over, as a lineup entry says it but for where it is (null with none armed): a stream that is not in the lineup has its level and mute here. `unreachable` says, for each output following the show that has an agent (an output with none reads nothing, and is left out), which of the streams the show needs its agent reaches no delivery of (`streamIds`, empty when it reaches them all): the cameras on screen, the stream armed to take over, and any stream one of those brings the sound of, each with at least one delivery but none at a gateway the agent reaches, from its network or the internet, and only at the gateway the output reads from when it names one (`inputGatewayId`). The output still places such a stream, so its card shows there. Protocols are not considered: which an agent asks with is its own.',
      responses: {
        200: { description: 'The show' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      const row = await transaction(async () => {
        // The show, its lineup, its takeover's mix and what its outputs cannot reach, as one transaction sees them;
        // nothing for one it cannot see.
        const show = await getShow(id, showId);
        if (!show) return undefined;
        const mixed = await getShowLineup(id, showId);
        const unreachable = mixed?.unreachable ?? [];
        return { ...show, lineup: mixed?.lineup ?? [], takeoverMix: mixed?.takeover ?? null, unreachable };
      });
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:showId',
    describeRoute({
      operationId: 'organisations.shows.update',
      ...operationVersion(1),
      summary: 'Rename a show',
      description: 'Administrators only.',
      responses: {
        200: { description: 'The updated show, without its outputs' },
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
    validator('param', ShowParamsSchema),
    validator('json', z.strictObject({ name: ShowNameSchema })),
    async c => {
      const { id, showId } = c.req.valid('param');
      const body = c.req.valid('json');
      const principal = usePrincipal();
      const row = await trustedTransaction(() => renameShow(principal, id, showId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:showId/controls',
    describeRoute({
      operationId: 'organisations.shows.controls.update',
      ...operationVersion(1),
      summary: 'Operate a show',
      description:
        "Any member: change its layout (`slots`), its own mix (`volumeDb`, `muted`), or its takeover: `takeoverStreamId` arms any of the organisation's streams, placed off air so it is already playing, and `takeoverLive` puts it on air, which takes the grid off and releases its cameras. Arming another stream, or disarming (`takeoverStreamId: null`), ends a live takeover unless `takeoverLive` is given too: `{ takeoverStreamId, takeoverLive: true }` cuts straight to the new stream. A takeover whose stream drops holds on its card until someone ends it. Only the fields given change; everyone following the show sees the result as its next update.",
      responses: {
        200: { description: 'The show, without its outputs and lineup' },
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
    validator('param', ShowParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          slots: SlotsSchema.optional(),
          volumeDb: VolumeSchema.optional(),
          muted: MutedSchema.optional(),
          takeoverStreamId: TakeoverStreamSchema.optional(),
          takeoverLive: TakeoverLiveSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, showId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateShowControls(id, showId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .post(
    '/:showId/lineup/swap',
    describeRoute({
      operationId: 'organisations.shows.lineup.swap',
      ...operationVersion(1),
      summary: "Swap two streams in a show's lineup",
      description:
        "Any member. `a` and `b` each name a stream in the lineup, by its ID or its position (from 1), or a pushed stream on standby by its ID, resolved against the lineup as it is when the swap is made; the two exchange places wherever they are: both on screen, or one off it, which is how a camera is brought on. A stream on standby takes the other's place, and that one leaves the lineup: a camera's rejoins at the end, a pushed one goes back to standby. A stream swapped with an empty slot (a position past the lineup's end that is on screen) takes the first empty slot. Refused (`invalid_reference`) for a stream that is neither in the lineup nor on standby, or a position past both. Returns the lineup after, as `organisations.shows.get` reads it.",
      responses: {
        200: { description: 'The lineup after the swap' },
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
    validator('param', ShowParamsSchema),
    validator('json', z.strictObject({ a: StreamReferenceSchema, b: StreamReferenceSchema })),
    async c => {
      const { id, showId } = c.req.valid('param');
      const { a, b } = c.req.valid('json');
      const principal = usePrincipal();
      const lineup = await trustedTransaction(() => swapLineup(principal, id, showId, a, b));
      c.header('Cache-Control', 'no-store');
      return c.json({ lineup }, 200);
    }
  )
  .patch(
    '/:showId/streams/:streamId',
    describeRoute({
      operationId: 'organisations.shows.streams.mix',
      ...operationVersion(1),
      summary: 'Set how a show mixes a stream',
      description:
        "Any member: the stream's level (`volumeDb`), whether it is muted, how far its sound is shifted against its picture (`syncOffsetMs`), and whose sound it brings (`audioStreamId`, null for its own). Kept for the show whether or not the stream is on screen. A stream never given any is at standard volume, not muted. A stream that brings another's sound is placed without its own, and the other is placed for its sound alone. Only the fields given change; everyone following the show hears the result in its next update.",
      responses: {
        200: { description: "The stream's settings in the show" },
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
    validator('param', ShowStreamParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          volumeDb: VolumeSchema.optional(),
          muted: MutedSchema.optional(),
          syncOffsetMs: SyncOffsetSchema.optional(),
          audioStreamId: AudioStreamSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, showId, streamId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateShowStream(id, showId, streamId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:showId',
    describeRoute({
      operationId: 'organisations.shows.delete',
      ...operationVersion(1),
      summary: 'Delete a show',
      description:
        'Administrators only. The outputs following it follow nothing until given another show: their OBS keeps streaming, with no scenes of the show.',
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
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      await transaction(() => deleteShow(id, showId));
      return c.body(null, 204);
    }
  )
  .get(
    '/:showId/follow',
    describeRoute({
      operationId: 'organisations.shows.follow',
      ...webSocket(),
      summary: 'Follow a show',
      description:
        "A WebSocket, sent the show as a vignette stream: its setup and latest update first, then each update as it is composed. Followed by the organisation's members, and by the agents of the outputs following it, signed as their devices. A show never composed is composed first. Closed with code 4404 once the show is deleted.",
      responses: {
        101: { description: 'Following the show' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        426: { description: 'The request is not a WebSocket handshake' },
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
      const principal = usePrincipal();
      if (principal.kind === 'device') await requireFollower(id, showId);
      else await requireShow(id, showId);
      const environment = useEnvironment();
      const broadcast = environment.broadcasts.get(showId);
      return broadcast.fetch(c.req.raw);
    }
  )
  .get('/:showId/stream', describeRoute({ hide: true }), validator('param', ShowParamsSchema), async c => {
    const { showId } = c.req.valid('param');
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
    const environment = useEnvironment();
    const broadcast = environment.broadcasts.get(showId);
    return broadcast.fetch(c.req.raw);
  })
  // Released versionless, while a show was composed by hand; kept, in its released shape, for the web tabs and CLIs
  // from then. A show composes itself now, so this only asks it to look again.
  .post(
    '/:showId/compose',
    describeRoute({
      operationId: 'organisations.shows.compose',
      deprecated: true,
      summary: 'Compose a show',
      description:
        'Deprecated: a show is composed from its state whenever that changes (`organisations.shows.controls.update`, `organisations.shows.lineup.swap`). This asks it to look again, and answers once it has. Any member.',
      responses: {
        204: { description: 'Composed' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      await requireShow(id, showId);
      const environment = useEnvironment();
      const broadcast = environment.broadcasts.get(showId);
      await broadcast.sync();
      return c.body(null, 204);
    }
  );
