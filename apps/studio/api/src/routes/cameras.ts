import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import {
  CameraCredentialsSchema,
  CameraPositionSchema,
  CameraSettingsSchema,
  chatName,
  MAX_ALIAS_LENGTH,
  MAX_ALIASES
} from '@conservationtv/cameras';
import { CAMERA_STATES } from '../cameras/states.ts';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { controlGrant, selectServingAgent } from '../cameras/grants.ts';
import { requirePrincipal, useAuthSession, useUser } from '../middleware/principal.ts';
import { audited } from '../audit/audit.ts';
import { getSessionBrowser } from '../services/browsers.ts';
import {
  createCamera,
  createCameraPreset,
  deleteCamera,
  deleteCameraPreset,
  getCamera,
  getPresetThumbnail,
  listCameras,
  presetThumbnailKey,
  requireCameraPermission,
  requireFreeAliases,
  setPresetThumbnail,
  updateCamera,
  updateCameraPreset
} from '../services/cameras.ts';
import { createDevice, deleteDevice, requireDevicePermission } from '../services/devices.ts';
import { NetworkReferenceSchema } from '../topology/settings.ts';
import { DeviceNameSchema } from './devices.ts';
import {
  aliasTaken,
  browserRequired,
  cameraUnavailable,
  forbidden,
  inUse,
  invalidReference,
  invalidRequest,
  notFound,
  operationVersion,
  presetNameTaken,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const CameraParamsSchema = OrganisationParamsSchema.extend({ cameraId: z.uuid().describe('The camera.') });
export type CameraParams = z.output<typeof CameraParamsSchema>;
const CameraStateSchema = z
  .enum(CAMERA_STATES)
  .describe('Whether the camera feeds its streams: only an `enabled` one does; `locked` and `disabled` both stop it.');
export type CameraState = z.output<typeof CameraStateSchema>;
const PresetParamsSchema = CameraParamsSchema.extend({ presetId: z.uuid().describe('The preset.') });
export type PresetParams = z.output<typeof PresetParamsSchema>;
const AliasesSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(MAX_ALIAS_LENGTH)
      .refine(alias => chatName(alias) !== '', 'An alias needs a letter or a digit')
  )
  .max(MAX_ALIASES)
  .refine(aliases => new Set(aliases.map(chatName)).size === aliases.length, 'Aliases must differ')
  .describe(
    'What else the camera is called in chat, beside its name: compared without case, spaces or punctuation, and not what another camera is called.'
  );
export type Aliases = z.output<typeof AliasesSchema>;
const PresetNameSchema = z.string().trim().min(1).max(60).describe('What the preset is called, such as `home`.');
export type PresetName = z.output<typeof PresetNameSchema>;

/** The kinds of picture a thumbnail may be, as a browser's canvas makes them. */
const THUMBNAIL_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
/** The largest thumbnail, in bytes: it is a small picture of a camera's view, not the view. */
const MAX_THUMBNAIL_BYTES = 256 * 1024;

const ThumbnailSchema = z
  .strictObject({
    contentType: z.enum(THUMBNAIL_TYPES),
    data: z
      .base64()
      .min(1)
      .max(Math.ceil((MAX_THUMBNAIL_BYTES * 4) / 3) + 4)
      .describe('The picture, as base64: at most 256 KiB once decoded.')
  })
  .describe('A small picture of what the camera sees at the preset.');
export type Thumbnail = z.output<typeof ThumbnailSchema>;

/** Forget a thumbnail's object once nothing points at it. A failure leaves an object nothing reads, and is logged. */
async function discardThumbnail(organisationId: string, presetId: string, token: string | null) {
  if (token === null) return;
  const environment = useEnvironment();
  try {
    await environment.media.delete(presetThumbnailKey(organisationId, presetId, token));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'thumbnail_discard_failed', presetId, error: String(error) }));
  }
}

/** A camera as the operations before its aliases and presets return it. */
function withoutChatNames<Camera extends ListedCamera>(camera: Camera) {
  const { aliases: _aliases, presets: _presets, ...rest } = camera;
  return rest;
}

/** What a camera is listed with from version 2, which earlier versions leave out. */
interface ListedCamera {
  aliases: string[];
  presets: object[];
}

// An organisation's cameras, in the principal's request session: members read them, administrators manage them. A
// camera is a device (src/db/schemas/cameras.ts): it is created and removed with its device, and its device's name and
// network are edited under /devices, with the same ID. From version 2 a camera comes with what else it is called in
// chat (`aliases`) and the positions saved for it (`presets`); version 1 serves agents and studios from before either.
//
// Controlling a camera never passes through this API: whoever may is given a grant (src/cameras/grants.ts) to present
// to the agent that reaches the camera, over iroh.

const NewCameraSchema = z.strictObject({
  name: DeviceNameSchema,
  networkId: NetworkReferenceSchema.default(null),
  settings: CameraSettingsSchema,
  credentials: CameraCredentialsSchema.optional(),
  state: CameraStateSchema.default('enabled')
});
export type NewCamera = z.output<typeof NewCameraSchema>;

const CameraChangesSchema = z.strictObject({
  settings: CameraSettingsSchema.optional(),
  credentials: CameraCredentialsSchema.nullable().optional(),
  state: CameraStateSchema.optional()
});
export type CameraChanges = z.output<typeof CameraChangesSchema>;

const AT_LEAST_ONE = 'Provide at least one field to change';

/** Create the camera's device and the camera, as trusted code, so the device's principal grant is made with it. */
async function addCamera(organisationId: string, body: NewCamera, aliases: string[]) {
  const principal = useUser();
  return trustedTransaction(async () => {
    await requireDevicePermission(organisationId, principal.id, 'create');
    await requireFreeAliases(organisationId, undefined, aliases);
    const device = await createDevice(organisationId, { kind: 'camera', name: body.name, networkId: body.networkId });
    await createCamera(organisationId, device.id, {
      settings: body.settings,
      credentials: body.credentials,
      state: body.state,
      aliases
    });
    const camera = await getCamera(organisationId, device.id);
    return camera!;
  });
}

const listResponses = {
  200: { description: 'The cameras, oldest first' },
  400: invalidRequest,
  401: unauthenticated,
  412: versionMismatch,
  503: unavailable
};
const createResponses = {
  201: { description: 'The new camera' },
  400: invalidRequest,
  401: unauthenticated,
  403: forbidden,
  412: versionMismatch,
  422: invalidReference,
  503: unavailable
};
const getResponses = {
  200: { description: 'The camera' },
  400: invalidRequest,
  401: unauthenticated,
  404: notFound,
  412: versionMismatch,
  503: unavailable
};
const updateResponses = {
  200: { description: 'The updated camera' },
  400: invalidRequest,
  401: unauthenticated,
  403: forbidden,
  404: notFound,
  412: versionMismatch,
  503: unavailable
};

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.cameras.list',
      ...operationVersion(1),
      summary: "List an organisation's cameras",
      description: 'Empty for organisations you are not a member of.',
      responses: listResponses
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const rows = await transaction(() => listCameras(id));
      c.header('Cache-Control', 'no-store');
      return c.json({ cameras: rows.map(withoutChatNames) }, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.cameras.list',
      ...operationVersion(2),
      summary: "List an organisation's cameras",
      description:
        'Empty for organisations you are not a member of. From this version, each camera comes with its `aliases`, what else it is called in chat, and its `presets`, the positions saved for it by name, oldest first.',
      responses: listResponses
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const rows = await transaction(() => listCameras(id));
      c.header('Cache-Control', 'no-store');
      return c.json({ cameras: rows }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.cameras.create',
      ...operationVersion(1),
      summary: 'Add a camera',
      description:
        'Administrators only. Creates the camera’s device, with a new Ed25519 identity, and the camera: its `settings` name the driver that reads it, and its `credentials`, never returned, how to authenticate to its streams. It starts `enabled` unless a `state` is given.',
      responses: createResponses
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', OrganisationParamsSchema),
    validator('json', NewCameraSchema),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await addCamera(id, body, []);
      c.header('Cache-Control', 'no-store');
      return c.json(withoutChatNames(row), 201);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.cameras.create',
      ...operationVersion(2),
      summary: 'Add a camera',
      description:
        'Administrators only. Creates the camera’s device, with a new Ed25519 identity, and the camera: its `settings` name the driver that reads and controls it, and its `credentials`, never returned, how to authenticate to it. It starts `enabled` unless a `state` is given. From this version, with its `aliases`: `conflict` (409) when another camera is already called by one.',
      responses: { ...createResponses, 409: aliasTaken }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', OrganisationParamsSchema),
    validator('json', NewCameraSchema.extend({ aliases: AliasesSchema.default([]) })),
    async c => {
      const { id } = c.req.valid('param');
      const { aliases, ...body } = c.req.valid('json');
      const row = await addCamera(id, body, aliases);
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:cameraId',
    describeRoute({
      operationId: 'organisations.cameras.get',
      ...operationVersion(1),
      summary: 'Read a camera',
      responses: getResponses
    }),
    requirePrincipal,
    validator('param', CameraParamsSchema),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const row = await transaction(() => getCamera(id, cameraId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(withoutChatNames(row), 200);
    }
  )
  .get(
    '/:cameraId',
    describeRoute({
      operationId: 'organisations.cameras.get',
      ...operationVersion(2),
      summary: 'Read a camera',
      description: 'From this version, with its `aliases` and its `presets`.',
      responses: getResponses
    }),
    requirePrincipal,
    validator('param', CameraParamsSchema),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const row = await transaction(() => getCamera(id, cameraId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:cameraId',
    describeRoute({
      operationId: 'organisations.cameras.update',
      ...operationVersion(1),
      summary: 'Update a camera',
      description:
        'Administrators only. Replaces its `settings` whole, its `credentials` when given (`null` clears them; credentials are never returned), and its `state`. Its name and network are changed under `/devices`, with the same ID.',
      responses: updateResponses
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', CameraParamsSchema),
    validator('json', CameraChangesSchema.refine(changes => Object.keys(changes).length > 0, AT_LEAST_ONE)),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(async () => {
        await updateCamera(id, cameraId, body);
        const camera = await getCamera(id, cameraId);
        return camera!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(withoutChatNames(row), 200);
    }
  )
  .patch(
    '/:cameraId',
    describeRoute({
      operationId: 'organisations.cameras.update',
      ...operationVersion(2),
      summary: 'Update a camera',
      description:
        'Administrators only. Replaces its `settings` whole, its `credentials` when given (`null` clears them; credentials are never returned), its `state`, and, from this version, its `aliases` whole: `conflict` (409) when another camera is already called by one. Its name and network are changed under `/devices`, with the same ID.',
      responses: { ...updateResponses, 409: aliasTaken }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', CameraParamsSchema),
    validator('json', CameraChangesSchema.extend({ aliases: AliasesSchema.optional() }).refine(
        changes => Object.keys(changes).length > 0,
        AT_LEAST_ONE
      )),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(async () => {
        if (body.aliases !== undefined) await requireFreeAliases(id, cameraId, body.aliases);
        await updateCamera(id, cameraId, body);
        const camera = await getCamera(id, cameraId);
        return camera!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:cameraId',
    describeRoute({
      operationId: 'organisations.cameras.delete',
      ...operationVersion(1),
      summary: 'Remove a camera',
      description:
        'Administrators only. Removes its device too, and its presets. Refused while a stream uses it as its source.',
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
    validator('param', CameraParamsSchema),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const principal = useUser();
      // Trusted, so the device's principal grant is revoked with it (src/services/devices.ts).
      await trustedTransaction(async () => {
        await requireDevicePermission(id, principal.id, 'remove');
        await deleteCamera(id, cameraId);
        await deleteDevice(id, cameraId);
      });
      return c.body(null, 204);
    }
  )
  .post(
    '/:cameraId/presets',
    describeRoute({
      operationId: 'organisations.cameras.presets.create',
      ...operationVersion(1),
      summary: 'Save a preset',
      description:
        'Administrators only. Saves a `position`, in the control contract’s units (`pan` and `tilt` in degrees, `zoom` and `focus` as fractions of the camera’s range), under a `name`: usually where the camera points now, which the studio reads from the agent that reaches it. `conflict` (409) when the camera has a preset of that name, whatever its case.',
      responses: {
        201: { description: 'The new preset' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        409: presetNameTaken,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', CameraParamsSchema),
    validator('json', z.strictObject({ name: PresetNameSchema, position: CameraPositionSchema })),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createCameraPreset(id, cameraId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .patch(
    '/:cameraId/presets/:presetId',
    describeRoute({
      operationId: 'organisations.cameras.presets.update',
      ...operationVersion(1),
      summary: 'Update a preset',
      description: 'Administrators only. Renames it, or saves another `position` as it.',
      responses: {
        200: { description: 'The updated preset' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: presetNameTaken,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', PresetParamsSchema),
    validator(
      'json',
      z
        .strictObject({ name: PresetNameSchema.optional(), position: CameraPositionSchema.optional() })
        .refine(changes => Object.keys(changes).length > 0, AT_LEAST_ONE)
    ),
    async c => {
      const { id, cameraId, presetId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateCameraPreset(id, cameraId, presetId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:cameraId/presets/:presetId',
    describeRoute({
      operationId: 'organisations.cameras.presets.delete',
      ...operationVersion(1),
      summary: 'Remove a preset',
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
    validator('param', PresetParamsSchema),
    async c => {
      const { id, cameraId, presetId } = c.req.valid('param');
      const deleted = await transaction(() => deleteCameraPreset(id, cameraId, presetId));
      await discardThumbnail(id, presetId, deleted.thumbnail);
      return c.body(null, 204);
    }
  )
  .get(
    '/:cameraId/presets/:presetId/thumbnail',
    describeRoute({
      operationId: 'organisations.cameras.presets.thumbnail.get',
      ...operationVersion(1),
      summary: "Read a preset's thumbnail",
      description:
        "The picture kept for the preset, as the image it was saved as. A preset's `thumbnail` is a token that changes whenever the picture is replaced: pass it as `v`, which this operation ignores, and the address can be cached for good. `not_found` for a preset with no thumbnail.",
      responses: {
        200: { description: 'The picture', content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', PresetParamsSchema),
    async c => {
      const { id, cameraId, presetId } = c.req.valid('param');
      const preset = await transaction(() => getPresetThumbnail(id, cameraId, presetId));
      if (!preset || preset.thumbnail === null) throw new ApiFailure('not_found');
      const environment = useEnvironment();
      const stored = await environment.media.get(presetThumbnailKey(id, presetId, preset.thumbnail));
      if (stored === null) throw new ApiFailure('not_found');
      c.header('Content-Type', stored.contentType);
      // The token in the address names exactly this picture: a replaced one has another address.
      c.header('Cache-Control', 'private, max-age=31536000, immutable');
      return c.body(stored.body, 200);
    }
  )
  .put(
    '/:cameraId/presets/:presetId/thumbnail',
    describeRoute({
      operationId: 'organisations.cameras.presets.thumbnail.set',
      ...operationVersion(1),
      summary: "Save a preset's thumbnail",
      description:
        'Administrators only. Keeps a small picture of what the camera sees at the preset, usually captured from its video in the studio as the preset is saved: WebP, JPEG or PNG, at most 256 KiB, as base64. Replaces any it had. Returns the preset, whose `thumbnail` is the new picture’s token.',
      responses: {
        200: { description: 'The preset, with its new thumbnail' },
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
    validator('param', PresetParamsSchema),
    validator('json', ThumbnailSchema),
    async c => {
      const { id, cameraId, presetId } = c.req.valid('param');
      const { contentType, data } = c.req.valid('json');
      const bytes = new Uint8Array(Buffer.from(data, 'base64'));
      const environment = useEnvironment();
      const token = crypto.randomUUID();
      // The row first, which row-level security lets only an administrator change: nothing is kept for anyone else.
      const before = await transaction(() => getPresetThumbnail(id, cameraId, presetId));
      const row = await transaction(() => setPresetThumbnail(id, cameraId, presetId, token));
      try {
        await environment.media.put(presetThumbnailKey(id, presetId, token), bytes, contentType);
      } catch (cause) {
        // A picture that could not be kept leaves the preset pointing at what it had.
        await transaction(() => setPresetThumbnail(id, cameraId, presetId, before?.thumbnail ?? null));
        throw new ApiFailure('database_unavailable', { cause });
      }
      await discardThumbnail(id, presetId, before?.thumbnail ?? null);
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:cameraId/presets/:presetId/thumbnail',
    describeRoute({
      operationId: 'organisations.cameras.presets.thumbnail.delete',
      ...operationVersion(1),
      summary: "Remove a preset's thumbnail",
      description: 'Administrators only. The preset keeps its position, and goes back to having no picture.',
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
    validator('param', PresetParamsSchema),
    async c => {
      const { id, cameraId, presetId } = c.req.valid('param');
      const before = await transaction(() => getPresetThumbnail(id, cameraId, presetId));
      await transaction(() => setPresetThumbnail(id, cameraId, presetId, null));
      await discardThumbnail(id, presetId, before?.thumbnail ?? null);
      return c.body(null, 204);
    }
  )
  .post(
    '/:cameraId/control',
    describeRoute({
      operationId: 'organisations.cameras.control.connect',
      ...operationVersion(1),
      summary: 'Ask to control a camera',
      description:
        "Administrators only, signed in. Controlling a camera never passes through this API: this returns the `agent` that reaches the camera (the active agent on its network, to dial over iroh at its `publicId`) and a `grant` to present to it with each command, in the `Camera-Grant` header. The grant is a JWT signed with that agent's own identity, which it verifies itself, naming the camera, the session's browser device as the only one that may present it, and that any command is admitted until `expiresAt`, a few minutes on: ask again to stay at the controls. `browser_required` (409) before `organisations.browser.ensure` has made the session's browser; `camera_unavailable` (503) when the camera is not `enabled` or its network has no active agent.",
      responses: {
        200: { description: 'The agent to dial, and the grant to present to it' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: browserRequired,
        412: versionMismatch,
        503: cameraUnavailable
      }
    }),
    requirePrincipal,
    validator('param', CameraParamsSchema),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const principal = useUser();
      const sessionId = useAuthSession();
      // Trusted: the agent's identity signs the grant, after the decision row-level security would make.
      const connection = await trustedTransaction(
        async () => {
          await requireCameraPermission(id, principal.id, 'edit');
          const browser = await getSessionBrowser(id, sessionId);
          if (browser === undefined) throw new ApiFailure('browser_required');
          const agent = await selectServingAgent(id, cameraId);
          if (agent === undefined) throw new ApiFailure('camera_unavailable');
          return { agent, holder: browser.publicId };
        },
        { name: 'camera.control' }
      );
      const { agent, holder } = connection;
      const signed = await controlGrant(agent, holder, cameraId);
      c.header('Cache-Control', 'no-store');
      return c.json({ agent: { id: agent.id, publicId: agent.publicId }, ...signed }, 200);
    }
  );
