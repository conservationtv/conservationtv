import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { connectPreview } from '../gateways/connect.ts';
import { ConnectionActionSchema } from '../gateways/provider.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import {
  createShow,
  createShowForward,
  createShowPreview,
  createShowRecorder,
  deleteShow,
  deleteShowForward,
  deleteShowOutput,
  deleteShowPreview,
  deleteShowRecorder,
  getShowOutput,
  getShowWithTopology,
  listShows,
  setShowOutput,
  showVisible,
  syncBroadcasters,
  updateShow,
  updateShowForward,
  updateShowRecorder
} from '../services/shows.ts';
import { RenditionSchema, SettingsSchema } from '../topology/settings.ts';
import { SHOW_RECORDER_KINDS } from '../topology/show-recorder-kinds.ts';
import { GatewayIdSchema } from './gateways.ts';
import {
  conflict,
  forbidden,
  gatewayUnavailable,
  invalidReference,
  invalidRequest,
  noCaller,
  notFound,
  operationVersion,
  outputInUse,
  previewConnectionRefused,
  unauthenticated,
  unavailable,
  unsupportedPreviewConnection,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const ShowParamsSchema = OrganisationParamsSchema.extend({ showId: z.uuid().describe('The show.') });
export type ShowParams = z.output<typeof ShowParamsSchema>;
const ForwardParamsSchema = ShowParamsSchema.extend({ forwardId: z.uuid().describe('The forward.') });
export type ForwardParams = z.output<typeof ForwardParamsSchema>;
const PreviewParamsSchema = ShowParamsSchema.extend({ previewId: z.uuid().describe('The preview.') });
export type PreviewParams = z.output<typeof PreviewParamsSchema>;
const ShowRecorderParamsSchema = ShowParamsSchema.extend({ recorderId: z.uuid().describe('The recorder.') });
export type ShowRecorderParams = z.output<typeof ShowRecorderParamsSchema>;

const ShowNameSchema = z.string().trim().min(1).max(120).describe('What the show is called in the studio.');
export type ShowName = z.output<typeof ShowNameSchema>;
const WidthSchema = z.int().min(160).max(3840).multipleOf(2).describe("The program's width in pixels: even.");
export type Width = z.output<typeof WidthSchema>;
const HeightSchema = z.int().min(90).max(2160).multipleOf(2).describe("The program's height in pixels: even.");
export type Height = z.output<typeof HeightSchema>;
const FpsSchema = z.int().min(1).max(60).describe("The program's frame rate.");
export type Fps = z.output<typeof FpsSchema>;
const BitrateSchema = z.int().min(500).max(50_000).describe("The program's constant video bitrate, in kbps.");
export type Bitrate = z.output<typeof BitrateSchema>;
const KeyframeSchema = z.int().min(1).max(10).describe("The program's keyframe interval, in seconds.");
export type Keyframe = z.output<typeof KeyframeSchema>;
const OutputDeviceSchema = z
  .uuid()
  .describe("The agent that drives OBS for the show: one of the organisation's, and no other show's output.");
export type OutputDevice = z.output<typeof OutputDeviceSchema>;
const ForwardEnabledSchema = z.boolean().describe('Whether the program goes out to the channel.');
export type ForwardEnabled = z.output<typeof ForwardEnabledSchema>;
const PreviewGatewaySchema = GatewayIdSchema.describe(
  "The gateway the program is published to and read from: built in, or the organisation's own."
);
export type PreviewGateway = z.output<typeof PreviewGatewaySchema>;
const PreviewActionSchema = ConnectionActionSchema.describe(
  'Whether to read the preview from its gateway, or publish it there.'
);
export type PreviewAction = z.output<typeof PreviewActionSchema>;
const PreviewProtocolSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe('One of the protocols the gateway is read by (to read), or published to (to publish), such as `webrtc`.');
export type PreviewProtocol = z.output<typeof PreviewProtocolSchema>;
const PreviewRenditionSchema = RenditionSchema.optional().describe(
  'The rendition to connect to: `default`, the one a preview offers, or left out.'
);
export type PreviewRendition = z.output<typeof PreviewRenditionSchema>;
const ShowRecorderKindSchema = z
  .enum(SHOW_RECORDER_KINDS)
  .describe('How the program is recorded: `obs`, by OBS alongside streaming it.');
export type ShowRecorderKind = z.output<typeof ShowRecorderKindSchema>;

// An organisation's shows going out (src/services/shows.ts), each with its output, the forwards that send its program
// to channels, the previews that publish it to gateways to be read, and the recorders that record it, in the
// principal's request session: members read them, administrators manage them. Every show follows the organisation's
// one broadcast for now (src/routes/broadcast.ts); what goes out differs by show. A show's output, an agent of the
// organisation, is granted `channelBroadcaster` while it is one (`syncBroadcasters`), to read its channels' ingests.

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.shows.list',
      ...operationVersion(1),
      summary: "List an organisation's shows",
      description:
        'Each with its output (null for none), forwards, previews and recorders, as `organisations.shows.get` reads one. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The shows, oldest first, each with its forwards, previews and recorders, oldest first' },
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
        "Administrators only. The program's encoding defaults to 1920×1080 at 30 fps, 6000 kbps, with 2-second keyframes. It goes out once it has an output.",
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
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z.strictObject({
        name: ShowNameSchema,
        width: WidthSchema.optional(),
        height: HeightSchema.optional(),
        fps: FpsSchema.optional(),
        bitrateKbps: BitrateSchema.optional(),
        keyframeSeconds: KeyframeSchema.optional()
      })
    ),
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
      description: 'With its output (null for none), forwards, previews and recorders.',
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
      const row = await transaction(() => getShowWithTopology(id, showId));
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
      summary: 'Update a show',
      description: "Administrators only: rename it, or change its program's encoding. Changes only the fields given.",
      responses: {
        200: { description: 'The updated show, without its output, forwards, previews and recorders' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          name: ShowNameSchema.optional(),
          width: WidthSchema.optional(),
          height: HeightSchema.optional(),
          fps: FpsSchema.optional(),
          bitrateKbps: BitrateSchema.optional(),
          keyframeSeconds: KeyframeSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, showId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateShow(id, showId, body));
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
        'Administrators only, with its output, forwards, previews and recorders. Its output stops running OBS for it.',
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
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      await transaction(() => deleteShow(id, showId));
      await trustedTransaction(() => syncBroadcasters(id));
      return c.body(null, 204);
    }
  )
  .get(
    '/:showId/output',
    describeRoute({
      operationId: 'organisations.shows.getOutput',
      ...operationVersion(1),
      summary: 'Read where a show goes out',
      description: 'The agent that drives OBS for it, following the broadcast and playing its streams.',
      responses: {
        200: { description: 'The output' },
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
      const row = await transaction(() => getShowOutput(id, showId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .put(
    '/:showId/output',
    describeRoute({
      operationId: 'organisations.shows.setOutput',
      ...operationVersion(1),
      summary: 'Set where a show goes out',
      description:
        "Administrators only. The agent, one of the organisation's and no other show's output, drives OBS for the show in place of any other: its configuration gains the `obs` runtime, and it follows the broadcast, reads the streams it shows, and sends the program to the show's forwards and previews. OBS agents run on Windows and macOS.",
      responses: {
        200: { description: 'The output' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: outputInUse,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    validator('json', z.strictObject({ deviceId: OutputDeviceSchema })),
    async c => {
      const { id, showId } = c.req.valid('param');
      const { deviceId } = c.req.valid('json');
      const row = await transaction(async () => {
        if (!(await showVisible(id, showId))) throw new ApiFailure('not_found');
        return setShowOutput(id, showId, deviceId);
      });
      await trustedTransaction(() => syncBroadcasters(id));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:showId/output',
    describeRoute({
      operationId: 'organisations.shows.deleteOutput',
      ...operationVersion(1),
      summary: 'Stop a show going out',
      description: 'Administrators only. Its agent stops running OBS for it.',
      responses: {
        204: { description: 'Stopped' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      await transaction(() => deleteShowOutput(id, showId));
      await trustedTransaction(() => syncBroadcasters(id));
      return c.body(null, 204);
    }
  )
  .post(
    '/:showId/forwards',
    describeRoute({
      operationId: 'organisations.shows.forwards.create',
      ...operationVersion(1),
      summary: 'Forward a show to a channel',
      description:
        "Administrators only. The show's output sends the program to the channel while the forward is enabled. Once per channel.",
      responses: {
        201: { description: 'The new forward' },
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
    validator('param', ShowParamsSchema),
    validator(
      'json',
      z.strictObject({
        channelId: z.uuid().describe("The channel: one of the organisation's."),
        enabled: ForwardEnabledSchema.default(true)
      })
    ),
    async c => {
      const { id, showId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(async () => {
        if (!(await showVisible(id, showId))) throw new ApiFailure('not_found');
        return createShowForward(id, showId, body);
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .patch(
    '/:showId/forwards/:forwardId',
    describeRoute({
      operationId: 'organisations.shows.forwards.update',
      ...operationVersion(1),
      summary: 'Turn a forward on or off',
      description: 'Administrators only. A forward that is off is not sent the program.',
      responses: {
        200: { description: 'The updated forward' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ForwardParamsSchema),
    validator('json', z.strictObject({ enabled: ForwardEnabledSchema })),
    async c => {
      const { id, showId, forwardId } = c.req.valid('param');
      const { enabled } = c.req.valid('json');
      const row = await transaction(() => updateShowForward(id, showId, forwardId, enabled));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:showId/forwards/:forwardId',
    describeRoute({
      operationId: 'organisations.shows.forwards.delete',
      ...operationVersion(1),
      summary: 'Remove a forward',
      description: 'Administrators only. The channel stays, for other shows.',
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
    validator('param', ForwardParamsSchema),
    async c => {
      const { id, showId, forwardId } = c.req.valid('param');
      await transaction(() => deleteShowForward(id, showId, forwardId));
      return c.body(null, 204);
    }
  )
  .post(
    '/:showId/previews',
    describeRoute({
      operationId: 'organisations.shows.previews.create',
      ...operationVersion(1),
      summary: 'Preview a show at a gateway',
      description:
        "Administrators only. The show's output publishes the program to the gateway, where members read it by the gateway's protocols, as an exposure of a stream is read. Once per gateway.",
      responses: {
        201: { description: 'The new preview' },
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
    validator('param', ShowParamsSchema),
    validator('json', z.strictObject({ gatewayId: PreviewGatewaySchema })),
    async c => {
      const { id, showId } = c.req.valid('param');
      const { gatewayId } = c.req.valid('json');
      const row = await transaction(async () => {
        if (!(await showVisible(id, showId))) throw new ApiFailure('not_found');
        return createShowPreview(id, showId, gatewayId);
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .delete(
    '/:showId/previews/:previewId',
    describeRoute({
      operationId: 'organisations.shows.previews.delete',
      ...operationVersion(1),
      summary: 'Remove a preview',
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
    validator('param', PreviewParamsSchema),
    async c => {
      const { id, showId, previewId } = c.req.valid('param');
      await transaction(() => deleteShowPreview(id, showId, previewId));
      return c.body(null, 204);
    }
  )
  .post(
    '/:showId/previews/:previewId/connections',
    describeRoute({
      operationId: 'organisations.shows.previews.connect',
      ...operationVersion(1),
      summary: 'Connect to a preview',
      description:
        "Where to read or publish the show's program at the preview's gateway by one of its protocols, with the short-lived credential that admits the caller there, as `organisations.streams.exposures.connect` gives for an exposure: a MoQ relay, path and token, or a URL and a token. A preview offers one rendition, `default`. Ask again before `expiresAt`. Members read, signed in. The show's output publishes, signed as its device (an RFC 9421 HTTP Message Signature by its own identity, as for `reports.submit`).",
      responses: {
        200: { description: 'The connection details' },
        400: invalidRequest,
        401: noCaller,
        403: previewConnectionRefused,
        404: notFound,
        412: versionMismatch,
        422: unsupportedPreviewConnection,
        503: gatewayUnavailable
      }
    }),
    requirePrincipal,
    validator('param', PreviewParamsSchema),
    validator(
      'json',
      z.strictObject({
        action: PreviewActionSchema,
        protocol: PreviewProtocolSchema,
        rendition: PreviewRenditionSchema
      })
    ),
    async c => {
      const { id, showId, previewId } = c.req.valid('param');
      const ask = c.req.valid('json');
      const connection = await connectPreview({ organisationId: id, showId, previewId }, ask);
      c.header('Cache-Control', 'no-store');
      return c.json(connection, 200);
    }
  )
  .post(
    '/:showId/recorders',
    describeRoute({
      operationId: 'organisations.shows.createRecorder',
      ...operationVersion(1),
      summary: 'Record a show',
      description:
        "Administrators only. `obs`: the show's output records the program alongside streaming it, into its data directory. One recorder of each kind.",
      responses: {
        201: { description: 'The new recorder' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: conflict,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    validator('json', z.strictObject({ kind: ShowRecorderKindSchema, params: SettingsSchema.default({}) })),
    async c => {
      const { id, showId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(async () => {
        if (!(await showVisible(id, showId))) throw new ApiFailure('not_found');
        return createShowRecorder(id, showId, body);
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .patch(
    '/:showId/recorders/:recorderId',
    describeRoute({
      operationId: 'organisations.shows.updateRecorder',
      ...operationVersion(1),
      summary: "Update a show's recorder",
      description: 'Administrators only. Changes only the fields given; `params` is replaced whole.',
      responses: {
        200: { description: 'The updated recorder' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: conflict,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowRecorderParamsSchema),
    validator(
      'json',
      z
        .strictObject({ kind: ShowRecorderKindSchema.optional(), params: SettingsSchema.optional() })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, showId, recorderId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateShowRecorder(id, showId, recorderId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:showId/recorders/:recorderId',
    describeRoute({
      operationId: 'organisations.shows.deleteRecorder',
      ...operationVersion(1),
      summary: "Remove a show's recorder",
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
    validator('param', ShowRecorderParamsSchema),
    async c => {
      const { id, showId, recorderId } = c.req.valid('param');
      await transaction(() => deleteShowRecorder(id, showId, recorderId));
      return c.body(null, 204);
    }
  );
