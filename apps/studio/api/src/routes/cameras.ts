import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { CameraCredentialsSchema, CameraSettingsSchema } from '../cameras/drivers.ts';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, useUser } from '../middleware/principal.ts';
import { createCamera, deleteCamera, getCamera, listCameras, updateCamera } from '../services/cameras.ts';
import { createDevice, deleteDevice, requireDevicePermission } from '../services/devices.ts';
import { NetworkReferenceSchema } from '../topology/settings.ts';
import { DeviceNameSchema } from './devices.ts';
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
const CameraParamsSchema = OrganisationParamsSchema.extend({ cameraId: z.uuid().describe('The camera.') });
export type CameraParams = z.output<typeof CameraParamsSchema>;

// An organisation's cameras, in the principal's request session: members read them, administrators manage them. A
// camera is a device (src/db/schemas/cameras.ts): it is created and removed with its device, and its device's name and
// network are edited under /devices, with the same ID.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.cameras.list',
      ...operationVersion(1),
      summary: "List an organisation's cameras",
      description: 'Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The cameras, oldest first' },
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
        'Administrators only. Creates the camera’s device, with a new Ed25519 identity, and the camera: its `settings` name the driver that reads it, and its `credentials`, never returned, how to authenticate to its streams.',
      responses: {
        201: { description: 'The new camera' },
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
        name: DeviceNameSchema,
        networkId: NetworkReferenceSchema.default(null),
        settings: CameraSettingsSchema,
        credentials: CameraCredentialsSchema.optional()
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const principal = useUser();
      // Trusted, so the device's principal grant is made with it (src/services/devices.ts).
      const row = await trustedTransaction(async () => {
        await requireDevicePermission(id, principal.id, 'create');
        const device = await createDevice(id, { kind: 'camera', name: body.name, networkId: body.networkId });
        await createCamera(id, device.id, { settings: body.settings, credentials: body.credentials });
        const camera = await getCamera(id, device.id);
        return camera!;
      });
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
      responses: {
        200: { description: 'The camera' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
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
        'Administrators only. Replaces its `settings` whole, and its `credentials` when given (`null` clears them); credentials are never returned. Its name and network are changed under `/devices`, with the same ID.',
      responses: {
        200: { description: 'The updated camera' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', CameraParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          settings: CameraSettingsSchema.optional(),
          credentials: CameraCredentialsSchema.nullable().optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, cameraId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(async () => {
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
      description: 'Administrators only. Removes its device too. Refused while a stream uses it as its source.',
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
  );
