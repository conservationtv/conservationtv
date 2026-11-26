import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { connectPreview } from '../gateways/connect.ts';
import { ConnectionActionSchema } from '../gateways/provider.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import { audited } from '../audit/audit.ts';
import {
  createOutput,
  createOutputControlChannel,
  createOutputForward,
  createOutputPreview,
  createOutputRecorder,
  deleteOutput,
  deleteOutputDevice,
  deleteOutputControlChannel,
  deleteOutputForward,
  deleteOutputPreview,
  deleteOutputRecorder,
  getOutputControl,
  getOutputDevice,
  getOutputWithTopology,
  listOutputs,
  outputVisible,
  reportOutputControl,
  selectDeviceOutput,
  setOutputDevice,
  syncBroadcasters,
  updateOutput,
  updateOutputForward,
  updateOutputRecorder,
  withoutInputGateway
} from '../services/outputs.ts';
import { OUTPUT_CONTROLS, OUTPUT_RECORDER_KINDS } from '../topology/output-recorder-kinds.ts';
import { checkOffered, RenditionSchema, withRenditions } from '../topology/renditions.ts';
import { SettingsSchema } from '../topology/settings.ts';
import { GatewayIdSchema } from './gateways.ts';
import {
  conflict,
  forbidden,
  gatewayUnavailable,
  invalidReference,
  invalidRequest,
  invalidSignature,
  noCaller,
  notFound,
  notOutputDevice,
  operationVersion,
  outputInUse,
  previewConnectionRefused,
  unauthenticated,
  unavailable,
  unsupportedPreviewConnection,
  unsupportedPreviewRendition,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const OutputParamsSchema = OrganisationParamsSchema.extend({ outputId: z.uuid().describe('The output.') });
export type OutputParams = z.output<typeof OutputParamsSchema>;
const ForwardParamsSchema = OutputParamsSchema.extend({ forwardId: z.uuid().describe('The forward.') });
export type ForwardParams = z.output<typeof ForwardParamsSchema>;
const ControlChannelParamsSchema = OutputParamsSchema.extend({ channelId: z.uuid().describe('The channel.') });
export type ControlChannelParams = z.output<typeof ControlChannelParamsSchema>;
const PreviewParamsSchema = OutputParamsSchema.extend({ previewId: z.uuid().describe('The preview.') });
export type PreviewParams = z.output<typeof PreviewParamsSchema>;
const RecorderParamsSchema = OutputParamsSchema.extend({ recorderId: z.uuid().describe('The recorder.') });
export type RecorderParams = z.output<typeof RecorderParamsSchema>;

const OutputNameSchema = z.string().trim().min(1).max(120).describe('What the output is called in the studio.');
export type OutputName = z.output<typeof OutputNameSchema>;
const OutputControlSchema = z
  .enum(OUTPUT_CONTROLS)
  .describe(
    "Who drives OBS's scenes: `show`, the show the output follows, or `external`, something outside the studio, for which the output reads any of the organisation's exposures and follows no show."
  );
export type OutputControl = z.output<typeof OutputControlSchema>;
const OutputShowSchema = z
  .uuid()
  .nullable()
  .describe("The show the output follows: one of the organisation's, or null for none. Only under `show` control.");
export type OutputShow = z.output<typeof OutputShowSchema>;
const WidthSchema = z.int().min(160).max(3840).multipleOf(2).describe("The programme's width in pixels: even.");
export type Width = z.output<typeof WidthSchema>;
const HeightSchema = z.int().min(90).max(2160).multipleOf(2).describe("The programme's height in pixels: even.");
export type Height = z.output<typeof HeightSchema>;
const FpsSchema = z.int().min(1).max(60).describe("The programme's frame rate.");
export type Fps = z.output<typeof FpsSchema>;
const BitrateSchema = z.int().min(500).max(50_000).describe("The programme's constant video bitrate, in kbps.");
export type Bitrate = z.output<typeof BitrateSchema>;
const KeyframeSchema = z.int().min(1).max(10).describe("The programme's keyframe interval, in seconds.");
export type Keyframe = z.output<typeof KeyframeSchema>;
const OutputDeviceSchema = z
  .uuid()
  .describe("The agent that runs the output's OBS: one of the organisation's, and no other output's.");
export type OutputDevice = z.output<typeof OutputDeviceSchema>;
const ForwardEnabledSchema = z.boolean().describe('Whether the programme goes out to the channel.');
export type ForwardEnabled = z.output<typeof ForwardEnabledSchema>;
const PreviewGatewaySchema = GatewayIdSchema.describe(
  "The gateway the programme is published to and read from: built in, or the organisation's own."
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
const RecorderKindSchema = z
  .enum(OUTPUT_RECORDER_KINDS)
  .describe('How the programme is recorded: `obs`, by OBS alongside streaming it.');
export type RecorderKind = z.output<typeof RecorderKindSchema>;
const WebsocketPortSchema = z.int().min(1).max(65_535).describe('The port obs-websocket listens on.');
export type WebsocketPort = z.output<typeof WebsocketPortSchema>;
const WebsocketPasswordSchema = z.string().min(1).max(200).describe("obs-websocket's password.");
export type WebsocketPassword = z.output<typeof WebsocketPasswordSchema>;
const SceneCollectionSchema = z
  .string()
  .min(1)
  .max(200)
  .describe("The scene collection OBS runs: the agent's own for a show, kept apart from an external controller's.");
export type SceneCollection = z.output<typeof SceneCollectionSchema>;
const InputUrlSchema = z
  .string()
  .min(1)
  .max(500)
  .describe(
    'Where OBS, on its own machine, reads any stream the output may read, whatever delivers it, with `{streamId}` in place of the stream: for a media source. Agents before streams were read by stream also have `{exposureId}`, in place of the delivery.'
  );
export type InputUrl = z.output<typeof InputUrlSchema>;

const InputGatewaySchema = GatewayIdSchema.nullable().describe(
  "The one gateway the output reads every stream from, built in or the organisation's own, whatever else delivers them; null lets each stream's read choose (`organisations.streams.connect`)."
);
export type InputGateway = z.output<typeof InputGatewaySchema>;

/** Every encoding field, each optional. */
const EncodingFields = {
  width: WidthSchema.optional(),
  height: HeightSchema.optional(),
  fps: FpsSchema.optional(),
  bitrateKbps: BitrateSchema.optional(),
  keyframeSeconds: KeyframeSchema.optional()
};

/** Who drives an output and the show it follows, as a body may give them. */
interface OutputDriving {
  control?: OutputControl;
  showId?: OutputShow;
}

/** Whether a body names no show under `external` control, which follows none. */
const noShowWhenExternal = (body: OutputDriving) =>
  body.control !== 'external' || body.showId === undefined || body.showId === null;

// An organisation's outputs (src/services/outputs.ts): each one OBS on one agent, with the forwards that send its
// programme to channels, the previews that publish it to gateways to be read, and the recorders that record it, in the
// principal's request session: members read them, administrators manage them. What is on screen is driven by the show
// it follows (src/routes/shows.ts) or, under `external` control, by something outside the studio, which reads how to
// reach OBS from `organisations.outputs.control.get`, as the agent reported it. An output's agent is granted
// `channelBroadcaster` while it is one (`syncBroadcasters`), to read its channels' ingests.

const PREVIEW_CONNECT_DESCRIPTION =
  "Where to read or publish the output's programme at the preview's gateway by one of its protocols, with the short-lived credential that admits the caller there, as `organisations.streams.exposures.connect` gives for an exposure: a MoQ relay, path and token, or a URL and a token. The programme is one encoding, so a preview carries that one picture. Ask again before `expiresAt`. Members read, signed in. The agent the output runs on publishes, signed as its device (an RFC 9421 HTTP Message Signature by its own identity, as for `reports.submit`).";

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.outputs.list',
      ...operationVersion(1),
      summary: "List an organisation's outputs",
      description:
        'Each with its device (null for none), forwards, previews and recorders, as `organisations.outputs.get` reads one. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The outputs, oldest first, each with its forwards, previews and recorders, oldest first' },
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
      const rows = await transaction(() => listOutputs(id));
      // As they were before outputs had an input gateway.
      const listed = rows.map(withoutInputGateway);
      c.header('Cache-Control', 'no-store');
      return c.json({ outputs: listed }, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.outputs.list',
      ...operationVersion(2),
      summary: "List an organisation's outputs",
      description:
        'Each with its input gateway, device (null for none), forwards, control channels, previews and recorders, as `organisations.outputs.get` reads one. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The outputs, oldest first, each with its forwards, previews and recorders, oldest first' },
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
      const rows = await transaction(() => listOutputs(id));
      c.header('Cache-Control', 'no-store');
      return c.json({ outputs: rows }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.outputs.create',
      ...operationVersion(1),
      summary: 'Create an output',
      description:
        "Administrators only. Under `show` control (the default) it follows the show given, if any; under `external`, none. The programme's encoding defaults to 1920×1080 at 30 fps, 6000 kbps, with 2-second keyframes. It goes out once it has a device.",
      responses: {
        201: { description: 'The new output' },
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
    validator(
      'json',
      z
        .strictObject({
          name: OutputNameSchema,
          control: OutputControlSchema.optional(),
          showId: OutputShowSchema.optional(),
          ...EncodingFields
        })
        .refine(noShowWhenExternal, 'An externally controlled output follows no show')
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createOutput(id, body));
      c.header('Cache-Control', 'no-store');
      return c.json(withoutInputGateway(row), 201);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.outputs.create',
      ...operationVersion(2),
      summary: 'Create an output',
      description:
        "Administrators only. Under `show` control (the default) it follows the show given, if any; under `external`, none. The programme's encoding defaults to 1920×1080 at 30 fps, 6000 kbps, with 2-second keyframes. It reads every stream from its `inputGatewayId` when that names one (built in, or the organisation's own: `invalid_reference` otherwise), and each from whichever suits it when null, the default. It goes out once it has a device.",
      responses: {
        201: { description: 'The new output' },
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
    validator(
      'json',
      z
        .strictObject({
          name: OutputNameSchema,
          control: OutputControlSchema.optional(),
          showId: OutputShowSchema.optional(),
          inputGatewayId: InputGatewaySchema.optional(),
          ...EncodingFields
        })
        .refine(noShowWhenExternal, 'An externally controlled output follows no show')
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createOutput(id, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:outputId',
    describeRoute({
      operationId: 'organisations.outputs.get',
      ...operationVersion(1),
      summary: 'Read an output',
      description: 'With its device (null for none), forwards, previews and recorders.',
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
    validator('param', OutputParamsSchema),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const row = await transaction(() => getOutputWithTopology(id, outputId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(withoutInputGateway(row), 200);
    }
  )
  .get(
    '/:outputId',
    describeRoute({
      operationId: 'organisations.outputs.get',
      ...operationVersion(2),
      summary: 'Read an output',
      description:
        'With its input gateway (`inputGatewayId`, null for none), its device (null for none), forwards, previews and recorders, and its `controlChannels`: the channels whose chat controls it besides those it goes out to (`organisations.outputs.controlChannels.create`).',
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
    validator('param', OutputParamsSchema),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const row = await transaction(() => getOutputWithTopology(id, outputId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:outputId',
    describeRoute({
      operationId: 'organisations.outputs.update',
      ...operationVersion(1),
      summary: 'Update an output',
      description:
        "Administrators only: rename it, change its programme's encoding, the show it follows, or who drives it. Changes only the fields given; `external` control leaves the show it followed, and a show under `external` control is a conflict.",
      responses: {
        200: { description: 'The updated output, without its device, forwards, previews and recorders' },
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
    validator('param', OutputParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          name: OutputNameSchema.optional(),
          control: OutputControlSchema.optional(),
          showId: OutputShowSchema.optional(),
          ...EncodingFields
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
        .refine(noShowWhenExternal, 'An externally controlled output follows no show')
    ),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateOutput(id, outputId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(withoutInputGateway(row), 200);
    }
  )
  .patch(
    '/:outputId',
    describeRoute({
      operationId: 'organisations.outputs.update',
      ...operationVersion(2),
      summary: 'Update an output',
      description:
        "Administrators only: rename it, change its programme's encoding, the show it follows, who drives it, or the one gateway it reads every stream from (`inputGatewayId`: built in, or the organisation's own, else `invalid_reference`; null to let each stream's read choose). Changes only the fields given; `external` control leaves the show it followed, and a show under `external` control is a conflict.",
      responses: {
        200: { description: 'The updated output, without its device, forwards, previews and recorders' },
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
    validator('param', OutputParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          name: OutputNameSchema.optional(),
          control: OutputControlSchema.optional(),
          showId: OutputShowSchema.optional(),
          inputGatewayId: InputGatewaySchema.optional(),
          ...EncodingFields
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
        .refine(noShowWhenExternal, 'An externally controlled output follows no show')
    ),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateOutput(id, outputId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:outputId',
    describeRoute({
      operationId: 'organisations.outputs.delete',
      ...operationVersion(1),
      summary: 'Delete an output',
      description:
        'Administrators only, with its device, forwards, previews and recorders. Its agent stops running OBS for it.',
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
    validator('param', OutputParamsSchema),
    async c => {
      const { id, outputId } = c.req.valid('param');
      await transaction(() => deleteOutput(id, outputId));
      await trustedTransaction(() => syncBroadcasters(id));
      return c.body(null, 204);
    }
  )
  .get(
    '/:outputId/device',
    describeRoute({
      operationId: 'organisations.outputs.getDevice',
      ...operationVersion(1),
      summary: 'Read the agent an output runs on',
      description: "The agent that runs the output's OBS.",
      responses: {
        200: { description: 'The device' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OutputParamsSchema),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const row = await transaction(() => getOutputDevice(id, outputId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .put(
    '/:outputId/device',
    describeRoute({
      operationId: 'organisations.outputs.setDevice',
      ...operationVersion(1),
      summary: 'Set the agent an output runs on',
      description:
        "Administrators only. The agent, one of the organisation's and no other output's, runs the output's OBS in place of any other: its configuration gains the `obs` runtime, streaming the programme to the output's forwards, previews and recorders, and the `show` runtime while the output follows a show. OBS agents run on Windows and macOS.",
      responses: {
        200: { description: 'The device' },
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
    audited('configuration'),
    validator('param', OutputParamsSchema),
    validator('json', z.strictObject({ deviceId: OutputDeviceSchema })),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const { deviceId } = c.req.valid('json');
      const row = await transaction(async () => {
        if (!(await outputVisible(id, outputId))) throw new ApiFailure('not_found');
        return setOutputDevice(id, outputId, deviceId);
      });
      await trustedTransaction(() => syncBroadcasters(id));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:outputId/device',
    describeRoute({
      operationId: 'organisations.outputs.deleteDevice',
      ...operationVersion(1),
      summary: 'Stop running an output',
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
    audited('configuration'),
    validator('param', OutputParamsSchema),
    async c => {
      const { id, outputId } = c.req.valid('param');
      await transaction(() => deleteOutputDevice(id, outputId));
      await trustedTransaction(() => syncBroadcasters(id));
      return c.body(null, 204);
    }
  )
  .get(
    '/:outputId/control',
    describeRoute({
      operationId: 'organisations.outputs.control.get',
      ...operationVersion(1),
      summary: "Read how to drive an output's OBS",
      description:
        "Administrators only: what its agent last reported. obs-websocket's port and password, on the agent's addresses (`organisations.devices.listAddresses`); the scene collection OBS runs; and `inputUrl`, where OBS reads a stream as a media source (`inputs/{streamId}` on the program MediaMTX), with `{streamId}` in place of the stream, whatever delivers it (an agent from before streams were read by stream reports one with `{exposureId}` too). An externally controlled output reads any of the organisation's streams; one following a show, only what the show places. `not_found` before the agent it runs on now has reported, and for anyone but an administrator.",
      responses: {
        200: { description: 'How to drive it' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OutputParamsSchema),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const row = await transaction(() => getOutputControl(id, outputId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .put(
    '/:outputId/control',
    describeRoute({
      operationId: 'organisations.outputs.control.report',
      ...operationVersion(1),
      summary: "Report how to drive an output's OBS",
      description:
        "The agent the output runs on, signed as its device (an RFC 9421 HTTP Message Signature by its own identity, as for `reports.submit`): obs-websocket's port and password, the scene collection OBS runs, and where OBS reads exposures, as `organisations.outputs.control.get` reads them. Replaces what it reported before.",
      responses: {
        204: { description: 'Kept' },
        400: invalidRequest,
        401: invalidSignature,
        403: notOutputDevice,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requireDevice,
    validator('param', OutputParamsSchema),
    validator(
      'json',
      z.strictObject({
        websocketPort: WebsocketPortSchema,
        websocketPassword: WebsocketPasswordSchema,
        sceneCollection: SceneCollectionSchema,
        inputUrl: InputUrlSchema
      })
    ),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const report = c.req.valid('json');
      const device = useDevice();
      await trustedTransaction(async () => {
        const output = await selectDeviceOutput(device.id);
        if (output?.outputId !== outputId || output.organisationId !== id) throw new ApiFailure('forbidden');
        await reportOutputControl(output, device.id, report);
      });
      return c.body(null, 204);
    }
  )
  .post(
    '/:outputId/forwards',
    describeRoute({
      operationId: 'organisations.outputs.forwards.create',
      ...operationVersion(1),
      summary: 'Forward an output to a channel',
      description:
        "Administrators only. The output's agent sends the programme to the channel while the forward is enabled. Once per channel.",
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
    audited('configuration'),
    validator('param', OutputParamsSchema),
    validator(
      'json',
      z.strictObject({
        channelId: z.uuid().describe("The channel: one of the organisation's."),
        enabled: ForwardEnabledSchema.default(true)
      })
    ),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(async () => {
        if (!(await outputVisible(id, outputId))) throw new ApiFailure('not_found');
        return createOutputForward(id, outputId, body);
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .patch(
    '/:outputId/forwards/:forwardId',
    describeRoute({
      operationId: 'organisations.outputs.forwards.update',
      ...operationVersion(1),
      summary: 'Turn a forward on or off',
      description: 'Administrators only. A forward that is off is not sent the programme.',
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
    audited('configuration'),
    validator('param', ForwardParamsSchema),
    validator('json', z.strictObject({ enabled: ForwardEnabledSchema })),
    async c => {
      const { id, outputId, forwardId } = c.req.valid('param');
      const { enabled } = c.req.valid('json');
      const row = await transaction(() => updateOutputForward(id, outputId, forwardId, enabled));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:outputId/forwards/:forwardId',
    describeRoute({
      operationId: 'organisations.outputs.forwards.delete',
      ...operationVersion(1),
      summary: 'Remove a forward',
      description: 'Administrators only. The channel stays, for other outputs.',
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
    validator('param', ForwardParamsSchema),
    async c => {
      const { id, outputId, forwardId } = c.req.valid('param');
      await transaction(() => deleteOutputForward(id, outputId, forwardId));
      return c.body(null, 204);
    }
  )
  .post(
    '/:outputId/control-channels',
    describeRoute({
      operationId: 'organisations.outputs.controlChannels.create',
      ...operationVersion(1),
      summary: "Let a channel's chat control an output",
      description:
        "Administrators only. The output's agent listens to the channel's chat for chat commands, and they act on its broadcast (its show and the organisation's cameras), whether or not the output goes out to the channel: as the Twitch channels it has an enabled forward to already do. A Twitch channel alone, connected with a login (`invalid_reference` otherwise). Replies are said there only when its connection may chat. Once per channel (`conflict`).",
      responses: {
        201: { description: 'The channel, controlling the output' },
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
    validator('param', OutputParamsSchema),
    validator(
      'json',
      z.strictObject({ channelId: z.uuid().describe("The channel: one of the organisation's Twitch channels.") })
    ),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const { channelId } = c.req.valid('json');
      const row = await transaction(async () => {
        if (!(await outputVisible(id, outputId))) throw new ApiFailure('not_found');
        return createOutputControlChannel(id, outputId, channelId);
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .delete(
    '/:outputId/control-channels/:channelId',
    describeRoute({
      operationId: 'organisations.outputs.controlChannels.delete',
      ...operationVersion(1),
      summary: "Stop a channel's chat controlling an output",
      description:
        'Administrators only. A channel the output goes out to still controls it while its forward is enabled.',
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
    validator('param', ControlChannelParamsSchema),
    async c => {
      const { id, outputId, channelId } = c.req.valid('param');
      await transaction(() => deleteOutputControlChannel(id, outputId, channelId));
      return c.body(null, 204);
    }
  )
  .post(
    '/:outputId/previews',
    describeRoute({
      operationId: 'organisations.outputs.previews.create',
      ...operationVersion(1),
      summary: 'Preview an output at a gateway',
      description:
        "Administrators only. The output's agent publishes the programme to the gateway, where members read it by the gateway's protocols, as an exposure of a stream is read. Once per gateway.",
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
    audited('configuration'),
    validator('param', OutputParamsSchema),
    validator('json', z.strictObject({ gatewayId: PreviewGatewaySchema })),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const { gatewayId } = c.req.valid('json');
      const row = await transaction(async () => {
        if (!(await outputVisible(id, outputId))) throw new ApiFailure('not_found');
        return createOutputPreview(id, outputId, gatewayId);
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .delete(
    '/:outputId/previews/:previewId',
    describeRoute({
      operationId: 'organisations.outputs.previews.delete',
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
    audited('configuration'),
    validator('param', PreviewParamsSchema),
    async c => {
      const { id, outputId, previewId } = c.req.valid('param');
      await transaction(() => deleteOutputPreview(id, outputId, previewId));
      return c.body(null, 204);
    }
  )
  .post(
    '/:outputId/previews/:previewId/connections',
    describeRoute({
      operationId: 'organisations.outputs.previews.connect',
      ...operationVersion(1),
      summary: 'Connect to a preview',
      description: `${PREVIEW_CONNECT_DESCRIPTION} A preview offers one rendition, \`default\`, and \`renditions\`, what the connection carries, says so.`,
      responses: {
        200: { description: 'The connection details' },
        400: invalidRequest,
        401: noCaller,
        403: previewConnectionRefused,
        404: notFound,
        412: versionMismatch,
        422: unsupportedPreviewRendition,
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
      const { id, outputId, previewId } = c.req.valid('param');
      const { rendition, ...ask } = c.req.valid('json');
      const connection = await connectPreview({ organisationId: id, outputId, previewId }, ask);
      // After whatever refuses the connection otherwise, as when a preview listed what it offered.
      checkOffered(rendition);
      c.header('Cache-Control', 'no-store');
      return c.json(withRenditions(connection), 200);
    }
  )
  .post(
    '/:outputId/previews/:previewId/connections',
    describeRoute({
      operationId: 'organisations.outputs.previews.connect',
      ...operationVersion(2),
      summary: 'Connect to a preview',
      description: PREVIEW_CONNECT_DESCRIPTION,
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
    validator('json', z.strictObject({ action: PreviewActionSchema, protocol: PreviewProtocolSchema })),
    async c => {
      const { id, outputId, previewId } = c.req.valid('param');
      const ask = c.req.valid('json');
      const connection = await connectPreview({ organisationId: id, outputId, previewId }, ask);
      c.header('Cache-Control', 'no-store');
      return c.json(connection, 200);
    }
  )
  .post(
    '/:outputId/recorders',
    describeRoute({
      operationId: 'organisations.outputs.createRecorder',
      ...operationVersion(1),
      summary: 'Record an output',
      description:
        "Administrators only. `obs`: the output's agent records the programme alongside streaming it, into its data directory. One recorder of each kind.",
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
    audited('configuration'),
    validator('param', OutputParamsSchema),
    validator('json', z.strictObject({ kind: RecorderKindSchema, params: SettingsSchema.default({}) })),
    async c => {
      const { id, outputId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(async () => {
        if (!(await outputVisible(id, outputId))) throw new ApiFailure('not_found');
        return createOutputRecorder(id, outputId, body);
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .patch(
    '/:outputId/recorders/:recorderId',
    describeRoute({
      operationId: 'organisations.outputs.updateRecorder',
      ...operationVersion(1),
      summary: "Update an output's recorder",
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
    audited('configuration'),
    validator('param', RecorderParamsSchema),
    validator(
      'json',
      z
        .strictObject({ kind: RecorderKindSchema.optional(), params: SettingsSchema.optional() })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, outputId, recorderId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateOutputRecorder(id, outputId, recorderId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:outputId/recorders/:recorderId',
    describeRoute({
      operationId: 'organisations.outputs.deleteRecorder',
      ...operationVersion(1),
      summary: "Remove an output's recorder",
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
      const { id, outputId, recorderId } = c.req.valid('param');
      await transaction(() => deleteOutputRecorder(id, outputId, recorderId));
      return c.body(null, 204);
    }
  );
